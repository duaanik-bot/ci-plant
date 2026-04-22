'use client'

import { useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import { PastingStyle } from '@prisma/client'
import { COATING_TYPES, EMBOSSING_TYPES, FOIL_TYPES, PAPER_TYPES, BOARD_GRADES } from '@/lib/constants'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { PoLinePastingStyleCell } from '@/components/po/PoLinePastingStyleCell'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import type { PoToolingSignal } from '@/lib/po-tooling-signal'

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
  ghostFromMaster: { size: boolean; gsm: boolean; pasting: boolean }
}

type ToolingMeta = { signal: PoToolingSignal; tooltip: string } | undefined

type PoNewLineItemDrawerProps = {
  isOpen: boolean
  onClose: () => void
  lineIndex: number
  line: Line | null
  updateLine: (idx: number, patch: Partial<Line>) => void
  fieldErrors: Record<string, string>
  inputBase: string
  inputCls: string
  inputClsGhost: string
  inputErr: string
  poMono: string
  masterPasteSavingLine: number | null
  masterPastePopoverLine: number | null
  setMasterPastePopoverLine: (n: number | null) => void
  onSavePastingToMaster: (lineIndex: number, cartonId: string, style: PastingStyle) => void
  toolingMeta: ToolingMeta
  toolingLoading: boolean
}

const SECTION_IDS = ['po-sec-material', 'po-sec-print', 'po-sec-tool', 'po-sec-cost'] as const

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

function dieStatusForTooling(
  line: Line,
  toolingMeta: ToolingMeta,
  toolingLoading: boolean,
): { label: string; detail: string } {
  if (toolingLoading) {
    return { label: 'Checking…', detail: 'Resolving against die / tooling' }
  }
  if (!line.cartonId) {
    return { label: '—', detail: 'Select a product to evaluate tooling' }
  }
  if (line.toolingUnlinked) {
    return {
      label: 'Missing (no Die Master)',
      detail: 'Link a die in Product Master before production handoff.',
    }
  }
  const sig = toolingMeta?.signal
  if (sig === 'green') {
    return { label: 'Ready', detail: toolingMeta?.tooltip ?? 'Tooling preflight looks good for this line.' }
  }
  if (sig === 'yellow') {
    return { label: 'Review', detail: toolingMeta?.tooltip ?? 'Confirm in die or plate workflow.' }
  }
  return { label: 'Blocked', detail: toolingMeta?.tooltip ?? 'Resolve in Die Hub or Product Master first.' }
}

function sectionTitle(text: string) {
  return (
    <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-800 pb-2">
      {text}
    </h3>
  )
}

function toolRow(emoji: string, label: string, status: 'ok' | 'warn' | 'bad', sub: string) {
  return (
    <div className="flex gap-2 py-1.5 border-b border-slate-800/60 last:border-0">
      <span className="text-base leading-tight" aria-hidden>
        {emoji}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-slate-200">{label}</p>
        <p
          className={`text-[10px] leading-relaxed ${
            status === 'ok' ? 'text-emerald-400/90' : status === 'warn' ? 'text-amber-400/90' : 'text-rose-400/90'
          }`}
        >
          {sub}
        </p>
      </div>
    </div>
  )
}

export function PoNewLineItemDrawer({
  isOpen,
  onClose,
  lineIndex,
  line,
  updateLine,
  fieldErrors,
  inputBase,
  inputCls,
  inputClsGhost,
  inputErr,
  poMono,
  masterPasteSavingLine,
  masterPastePopoverLine,
  setMasterPastePopoverLine,
  onSavePastingToMaster,
  toolingMeta,
  toolingLoading,
}: PoNewLineItemDrawerProps) {
  const panelRootRef = useRef<HTMLDivElement | null>(null)

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

  const die = line ? dieStatusForTooling(line, toolingMeta, toolingLoading) : { label: '', detail: '' }
  const dieEmoji =
    !line || !line.cartonId
      ? '⚪'
      : toolingLoading
        ? '⚪'
        : line.toolingUnlinked
          ? '🔴'
          : toolingMeta?.signal === 'green'
            ? '🟢'
            : toolingMeta?.signal === 'yellow'
              ? '🟡'
              : '🔴'
  const plateEmoji: 'ok' | 'warn' | 'bad' =
    !line || !line.cartonId ? 'bad' : toolingMeta?.signal === 'green' && !line.toolingUnlinked ? 'ok' : 'warn'
  const plateSub =
    line && line.cartonId
      ? 'Follow Designing / CTP; link product in Plate Hub when artwork is final.'
      : 'Select a line product first.'

  const embossEmoji: 'ok' | 'warn' | 'bad' = line?.embossingLeafing
    ? line.embossingLeafing === 'No embossing' || line.embossingLeafing === 'None' || !line.embossingLeafing
      ? 'ok'
      : 'warn'
    : 'ok'
  const embossSub = line?.embossingLeafing
    ? line.embossingLeafing
    : 'Set emboss/foil in Printing above if required.'

  return (
    <SlideOverPanel
      title={line ? `Line ${lineIndex + 1} — ${line.cartonName.trim() || 'New line'}` : 'Line item'}
      isOpen={isOpen}
      onClose={onClose}
      widthClass="max-w-md w-full"
      backdropClassName="bg-background/60"
      panelClassName="border-l border-slate-700 bg-slate-950 text-foreground shadow-xl"
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
          <p className="text-sm text-slate-500">No line selected.</p>
        ) : (
          <>
            <p className="text-[10px] text-slate-500">
              <kbd className="rounded border border-slate-600 px-1">Tab</kbd> fields ·{' '}
              <kbd className="rounded border border-slate-600 px-1">Enter</kbd> next ·{' '}
              <kbd className="rounded border border-slate-600 px-1">Ctrl</kbd>+
              <kbd className="rounded border border-slate-600 px-1">Enter</kbd> done ·{' '}
              <kbd className="rounded border border-slate-600 px-1">Ctrl</kbd>+→ section
            </p>

            <section id="po-sec-material" className="space-y-2.5">
              {sectionTitle('Material')}
              <div>
                <label className="mb-1 block text-xs text-slate-400">Board</label>
                <div data-skip-po-enter-chain>
                  <PackagingEnumCombobox
                    aria-label="Board grade"
                    options={BOARD_GRADES}
                    value={line.boardGrade || null}
                    onChange={(v) => updateLine(lineIndex, { boardGrade: v ?? '' })}
                    controlClassName="border-slate-700 bg-slate-900/80"
                    inputClassName="text-xs text-slate-100"
                    className="w-full"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">GSM</label>
                <input
                  type="number"
                  value={line.gsm}
                  onChange={(e) =>
                    updateLine(lineIndex, {
                      gsm: e.target.value,
                      ghostFromMaster: { ...line.ghostFromMaster, gsm: false },
                    })
                  }
                  className={`w-full ${inputBase} text-foreground border ${
                    line.ghostFromMaster.gsm ? inputClsGhost : inputCls
                  } ${poMono}`}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Paper</label>
                <div data-skip-po-enter-chain>
                  <PackagingEnumCombobox
                    aria-label="Paper / board type"
                    options={PAPER_TYPES}
                    value={line.paperType || null}
                    onChange={(v) => updateLine(lineIndex, { paperType: v ?? '' })}
                    controlClassName="border-slate-700 bg-slate-900/80"
                    inputClassName="text-xs text-slate-100"
                    className="w-full"
                  />
                </div>
              </div>
            </section>

            <section id="po-sec-print" className="space-y-2.5">
              {sectionTitle('Printing')}
              <div>
                <label className="mb-1 block text-xs text-slate-400">Coating</label>
                <div data-skip-po-enter-chain>
                  <PackagingEnumCombobox
                    aria-label="Coating"
                    options={COATING_TYPES}
                    value={line.coatingType || null}
                    onChange={(v) => updateLine(lineIndex, { coatingType: v ?? '' })}
                    controlClassName="border-slate-700 bg-slate-900/80"
                    inputClassName="text-xs text-slate-100"
                    className="w-full"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Emboss / leafing</label>
                <div data-skip-po-enter-chain>
                  <PackagingEnumCombobox
                    aria-label="Embossing and leafing"
                    options={EMBOSSING_TYPES}
                    value={line.embossingLeafing || null}
                    onChange={(v) => updateLine(lineIndex, { embossingLeafing: v ?? '' })}
                    controlClassName="border-slate-700 bg-slate-900/80"
                    inputClassName="text-xs text-slate-100"
                    className="w-full"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Foil</label>
                <div data-skip-po-enter-chain>
                  <PackagingEnumCombobox
                    aria-label="Foil"
                    options={FOIL_TYPES}
                    value={line.foilType || null}
                    onChange={(v) => updateLine(lineIndex, { foilType: v ?? '' })}
                    controlClassName="border-slate-700 bg-slate-900/80"
                    inputClassName="text-xs text-slate-100"
                    className="w-full"
                  />
                </div>
              </div>
              <div data-skip-po-enter-chain className="space-y-1">
                <label className="mb-1 block text-xs text-slate-400">Pasting</label>
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
            </section>

            <section id="po-sec-tool" className="space-y-0 rounded-lg border border-slate-800 bg-slate-900/50 p-2">
              {sectionTitle('Tooling')}
              {toolRow(dieEmoji, 'Die / master', !line || !line.cartonId || toolingLoading ? 'bad' : line.toolingUnlinked || toolingMeta?.signal === 'red' ? 'bad' : toolingMeta?.signal === 'yellow' ? 'warn' : 'ok', die.detail || die.label || '—')}
              {toolRow(plateEmoji === 'ok' ? '🟢' : plateEmoji === 'warn' ? '🟡' : '🔴', 'Plate mapping', plateEmoji, plateSub)}
              {toolRow(embossEmoji === 'ok' ? '🟢' : embossEmoji === 'warn' ? '🟡' : '🔴', 'Emboss / block', embossEmoji, embossSub)}
              {line.dieMasterId ? (
                <p className="pt-1 text-[10px] text-slate-500">
                  Die link: <span className="font-mono text-slate-400">{line.dieMasterId}</span>
                </p>
              ) : null}
              <p className="pt-1 text-[10px] text-slate-500">
                <Link href="/orders/designing" className="text-amber-400/90 hover:underline">
                  Plate Hub
                </Link>
                {line.cartonId ? (
                  <>
                    {' · '}
                    <Link href={`/masters/cartons/${line.cartonId}`} className="text-amber-400/90 hover:underline">
                      Product
                    </Link>
                  </>
                ) : null}
                {' · '}
                <Link href="/masters/dies" className="text-amber-400/90 hover:underline">
                  Dies
                </Link>
              </p>
            </section>

            <section id="po-sec-cost" className="space-y-2.5">
              {sectionTitle('Costing')}
              <div>
                <label className="mb-1 block text-xs text-slate-400">Quantity</label>
                <input
                  type="number"
                  min={1}
                  value={line.quantity}
                  onChange={(e) => updateLine(lineIndex, { quantity: e.target.value })}
                  className={`w-full ${inputCls} ${poMono}`}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Rate (per unit, ex-GST)</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={line.rate}
                  onChange={(e) => updateLine(lineIndex, { rate: e.target.value })}
                  className={`w-full ${inputCls} ${poMono} ${fieldErrors[`line${lineIndex}_rate`] ? inputErr : ''}`}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Wastage %</label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={line.wastagePct}
                  onChange={(e) => updateLine(lineIndex, { wastagePct: e.target.value })}
                  className={`w-full ${inputCls} ${poMono}`}
                />
                {chQty > 0 && (Number(line.wastagePct) || 0) > 0 ? (
                  <p className="mt-1 text-[10px] text-slate-500">
                    Chargeable qty (incl. waste):{' '}
                    <span className={`${poMono} text-slate-300`}>
                      {chQty.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </span>
                  </p>
                ) : null}
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">GST %</label>
                <input
                  type="number"
                  min={0}
                  max={28}
                  value={line.gstPct}
                  onChange={(e) => updateLine(lineIndex, { gstPct: e.target.value })}
                  className={`w-full ${inputCls} ${poMono}`}
                />
                <p className="mt-0.5 text-[10px] text-slate-600">Applies to line value (ex-GST) unless you change it.</p>
              </div>
              <div className={`space-y-1.5 border border-slate-800/80 bg-slate-900/50 p-2.5 ${poMono} text-xs`}>
                <div className="flex justify-between text-slate-400">
                  <span>Line amount (ex-GST)</span>
                  <span className="text-slate-200">₹ {money.exGst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>GST</span>
                  <span className="text-slate-200">₹ {money.gstAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between border-t border-slate-800 pt-1.5 font-medium text-amber-200/95">
                  <span>Line total (incl. GST)</span>
                  <span>₹ {money.lineTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Back print</label>
                <select
                  value={line.backPrint}
                  onChange={(e) => updateLine(lineIndex, { backPrint: e.target.value })}
                  className={`w-full ${inputCls}`}
                >
                  <option value="No">No</option>
                  <option value="Yes">Yes</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Artwork code</label>
                <input
                  type="text"
                  value={line.artworkCode}
                  onChange={(e) => updateLine(lineIndex, { artworkCode: e.target.value })}
                  className={`w-full ${inputCls} font-mono text-xs`}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Line remarks</label>
                <textarea
                  rows={4}
                  value={line.remarks}
                  onChange={(e) => updateLine(lineIndex, { remarks: e.target.value })}
                  className="w-full rounded border border-slate-600 bg-slate-800 px-3 py-2 text-foreground text-sm"
                />
              </div>
            </section>
          </>
        )}
      </div>
    </SlideOverPanel>
  )
}
