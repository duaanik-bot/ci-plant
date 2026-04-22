'use client'

import { Fragment, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import Link from 'next/link'
import { RotateCcw, Star } from 'lucide-react'
import { toast } from 'sonner'
import { broadcastIndustrialPriorityChange } from '@/lib/industrial-priority-sync'
import { INDUSTRIAL_PRIORITY_STAR_ICON_CLASS } from '@/lib/industrial-priority-ui'
import {
  computeBatchProfitabilityIndex,
  formatWhatIfPriorityMessage,
} from '@/lib/planning-predictive'
import {
  computeSheetUtilization,
  formatSheetSizeMm,
  readPlanningCore,
  type PlanningDesignerKey,
} from '@/lib/planning-decision-spec'
import {
  MASTER_BOARD_GRADES,
  MASTER_COATINGS_AND_VARNISHES,
  MASTER_EMBOSSING_AND_LEAFING,
} from '@/lib/master-enums'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { EnterpriseTableShell } from '@/components/ui/EnterpriseTableShell'

const cellBase =
  'h-12 max-h-12 px-3 py-0 align-middle text-[12px] font-medium text-slate-200 border-b border-slate-800 whitespace-nowrap overflow-hidden text-ellipsis max-w-[14rem]'
const monoStrong =
  'font-designing-queue text-[12px] font-semibold tabular-nums text-amber-300'
const theadBtn =
  'inline-flex items-center gap-0.5 text-left text-[10px] font-medium uppercase tracking-wider text-slate-500 hover:text-amber-300'

type DieMaster = { id: string; dyeNumber: number; ups: number; sheetSize: string }

export type PlanningGridLine = {
  id: string
  cartonId: string | null
  cartonName: string
  cartonSize: string | null
  quantity: number
  rate?: number | null
  directorPriority?: boolean
  artworkCode: string | null
  coatingType: string | null
  otherCoating: string | null
  embossingLeafing: string | null
  paperType: string | null
  gsm: number | null
  remarks: string | null
  planningStatus: string
  specOverrides: Record<string, unknown> | null
  dimLengthMm?: unknown
  dimWidthMm?: unknown
  planningLedger?: {
    numberOfColours?: number | null
  } | null
  po: {
    id: string
    poNumber: string
    poDate: string
    isPriority?: boolean
    customer: { id: string; name: string }
  }
  materialQueue?: {
    ups?: number
    sheetLengthMm?: unknown
    sheetWidthMm?: unknown
  } | null
  carton?: {
    blankLength?: unknown
    blankWidth?: unknown
    artworkCode?: string | null
    laminateType?: string | null
    coatingType?: string | null
    numberOfColours?: number | null
  } | null
  dieMaster?: DieMaster | null
}

type SortKey =
  | 'poNumber'
  | 'poDate'
  | 'client'
  | 'cartonName'
  | 'artworkCode'
  | 'cartonSize'
  | 'qty'
  | 'dyeUps'
  | 'sheetSize'
  | 'coating'
  | 'otherCoating'
  | 'emboss'
  | 'paper'
  | 'gsm'
  | 'ups'
  | 'remarks'

function poDateMs(d: string) {
  const t = Date.parse(d)
  return Number.isFinite(t) ? t : 0
}

function sortLines(list: PlanningGridLine[], key: SortKey, dir: 'asc' | 'desc'): PlanningGridLine[] {
  const m = dir === 'asc' ? 1 : -1
  const specOf = (r: PlanningGridLine) => (r.specOverrides || {}) as Record<string, unknown>
  return [...list].sort((a, b) => {
    let cmp = 0
    switch (key) {
      case 'poNumber':
        cmp = a.po.poNumber.localeCompare(b.po.poNumber, undefined, { numeric: true })
        break
      case 'poDate':
        cmp = poDateMs(a.po.poDate) - poDateMs(b.po.poDate)
        break
      case 'client':
        cmp = a.po.customer.name.localeCompare(b.po.customer.name)
        break
      case 'cartonName':
        cmp = a.cartonName.localeCompare(b.cartonName)
        break
      case 'artworkCode':
        cmp = String(artworkCodeFor(a)).localeCompare(String(artworkCodeFor(b)))
        break
      case 'cartonSize':
        cmp = String(a.cartonSize ?? '').localeCompare(String(b.cartonSize ?? ''), undefined, { numeric: true })
        break
      case 'qty':
        cmp = a.quantity - b.quantity
        break
      case 'dyeUps':
        cmp = dyeUpsSortKey(a).localeCompare(dyeUpsSortKey(b), undefined, { numeric: true })
        break
      case 'sheetSize':
        cmp = sheetSizeLabel(a, specOf(a)).localeCompare(sheetSizeLabel(b, specOf(b)))
        break
      case 'coating':
        cmp = String(a.coatingType ?? '').localeCompare(String(b.coatingType ?? ''))
        break
      case 'otherCoating':
        cmp = String(a.otherCoating ?? '').localeCompare(String(b.otherCoating ?? ''))
        break
      case 'emboss':
        cmp = String(a.embossingLeafing ?? '').localeCompare(String(b.embossingLeafing ?? ''))
        break
      case 'paper':
        cmp = String(a.paperType ?? '').localeCompare(String(b.paperType ?? ''))
        break
      case 'gsm':
        cmp = (a.gsm ?? 0) - (b.gsm ?? 0)
        break
      case 'ups': {
        const ua = readPlanningCore(specOf(a)).ups ?? a.materialQueue?.ups ?? 0
        const ub = readPlanningCore(specOf(b)).ups ?? b.materialQueue?.ups ?? 0
        cmp = ua - ub
        break
      }
      case 'remarks':
        cmp = String(a.remarks ?? '').localeCompare(String(b.remarks ?? ''))
        break
      default:
        cmp = 0
    }
    if (cmp !== 0) return cmp * m
    return a.po.poNumber.localeCompare(b.po.poNumber)
  })
}

function artworkCodeFor(r: PlanningGridLine) {
  return (r.artworkCode ?? r.carton?.artworkCode ?? '').trim()
}

function dyeUpsSortKey(r: PlanningGridLine) {
  const dm = r.dieMaster
  if (dm) return `${dm.dyeNumber}/${dm.ups}`
  return '0'
}

function sheetSizeLabel(r: PlanningGridLine, spec: Record<string, unknown>) {
  const pc = readPlanningCore(spec)
  if (pc.actualSheetSizeLabel) return pc.actualSheetSizeLabel
  const sl = Number(r.materialQueue?.sheetLengthMm ?? 0)
  const sw = Number(r.materialQueue?.sheetWidthMm ?? 0)
  if (sl > 0 && sw > 0) return formatSheetSizeMm(sl, sw)
  return '—'
}

function dyeUpsDisplay(r: PlanningGridLine) {
  const dm = r.dieMaster
  if (dm) return `${dm.dyeNumber}/${dm.ups}`
  return 'NEW'
}

function numberOfColoursFor(r: PlanningGridLine): number {
  const spec = r.specOverrides as Record<string, unknown> | null
  const n = spec && typeof spec.numberOfColours === 'number' ? spec.numberOfColours : null
  return n ?? r.planningLedger?.numberOfColours ?? r.carton?.numberOfColours ?? 4
}

function TruncatedWithTooltip({
  value,
  className = '',
}: {
  value: string
  className?: string
}) {
  return (
    <div className={`group relative min-w-0 ${className}`}>
      <span className="block truncate">{value}</span>
      <div className="pointer-events-none absolute left-0 top-[calc(100%+4px)] z-20 hidden max-w-[24rem] rounded border border-slate-700 bg-black px-2 py-1 text-xs text-slate-100 shadow-lg group-hover:block">
        {value}
      </div>
    </div>
  )
}

export function PlanningDecisionGrid({
  rows,
  ledgerView,
  planningSelection,
  setPlanningSelection,
  onRowBackgroundClick,
  updateSpec,
  updateRow,
  onRemoveLine,
  onRecallLine,
  onSaveRow,
  mixConflictMessage,
  onLinkAsMixSet,
}: {
  rows: PlanningGridLine[]
  ledgerView: 'pending' | 'processed'
  planningSelection: Set<string>
  setPlanningSelection: React.Dispatch<React.SetStateAction<Set<string>>>
  onRowBackgroundClick: (lineId: string) => void
  updateSpec: (id: string, patch: Record<string, unknown>) => void
  updateRow: (id: string, patch: Partial<PlanningGridLine>) => void
  onRemoveLine: (line: PlanningGridLine) => void
  onRecallLine: (lineId: string) => Promise<void>
  onSaveRow?: (lineId: string) => Promise<void>
  mixConflictMessage: string | null
  onLinkAsMixSet: () => void
}) {
  const [sortKey, setSortKey] = useState<SortKey>('poDate')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [flash, setFlash] = useState(false)
  const [simulateImpactMode, setSimulateImpactMode] = useState(false)
  const [priorityBusyPoId, setPriorityBusyPoId] = useState<string | null>(null)

  const [fClient, setFClient] = useState('')
  const [fCoating, setFCoating] = useState('')
  const [fOtherCoating, setFOtherCoating] = useState('')
  const [fEmboss, setFEmboss] = useState('')
  const [fPaper, setFPaper] = useState('')
  const [fPo, setFPo] = useState('')
  const [fCarton, setFCarton] = useState('')
  const [fSize, setFSize] = useState('')
  const [fQty, setFQty] = useState('')
  const [fGsm, setFGsm] = useState('')

  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkUps, setBulkUps] = useState<number | ''>('')
  const [bulkDesigner, setBulkDesigner] = useState<PlanningDesignerKey | ''>('')

  useEffect(() => {
    if (!mixConflictMessage) return
    setFlash(true)
    const t = window.setTimeout(() => setFlash(false), 2200)
    return () => window.clearTimeout(t)
  }, [mixConflictMessage])

  const viewRows = useMemo(() => {
    return rows.filter((r) => {
      const pending = r.planningStatus === 'pending'
      if (ledgerView === 'pending') return pending
      return !pending
    })
  }, [rows, ledgerView])

  const uniq = useCallback((vals: (string | null | undefined)[]) => {
    const s = new Set<string>()
    for (const v of vals) {
      const t = String(v ?? '').trim()
      if (t) s.add(t)
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }, [])

  const optClients = useMemo(
    () => uniq(viewRows.map((r) => r.po.customer.name)),
    [viewRows, uniq],
  )
  const optCoating = useMemo(() => {
    const fromRows = uniq(viewRows.map((r) => r.coatingType))
    return Array.from(new Set([...MASTER_COATINGS_AND_VARNISHES, ...fromRows])).sort((a, b) =>
      a.localeCompare(b),
    )
  }, [viewRows, uniq])
  const optOther = useMemo(() => {
    const fromRows = uniq(viewRows.map((r) => r.otherCoating))
    return Array.from(new Set([...MASTER_COATINGS_AND_VARNISHES, ...fromRows])).sort((a, b) =>
      a.localeCompare(b),
    )
  }, [viewRows, uniq])
  const optEmb = useMemo(() => {
    const fromRows = uniq(viewRows.map((r) => r.embossingLeafing))
    return Array.from(new Set([...MASTER_EMBOSSING_AND_LEAFING, ...fromRows])).sort((a, b) =>
      a.localeCompare(b),
    )
  }, [viewRows, uniq])
  const optPaper = useMemo(() => {
    const fromRows = uniq(viewRows.map((r) => r.paperType))
    return Array.from(new Set([...MASTER_BOARD_GRADES, ...fromRows])).sort((a, b) => a.localeCompare(b))
  }, [viewRows, uniq])

  const filtered = useMemo(() => {
    const match = (hay: string, needle: string) =>
      !needle.trim() || hay.toLowerCase().includes(needle.trim().toLowerCase())
    return viewRows.filter((r) => {
      if (fClient && r.po.customer.name !== fClient) return false
      if (fCoating && String(r.coatingType ?? '') !== fCoating) return false
      if (fOtherCoating && String(r.otherCoating ?? '') !== fOtherCoating) return false
      if (fEmboss && String(r.embossingLeafing ?? '') !== fEmboss) return false
      if (fPaper && String(r.paperType ?? '') !== fPaper) return false
      if (!match(r.po.poNumber, fPo)) return false
      if (!match(r.cartonName, fCarton)) return false
      if (!match(String(r.cartonSize ?? ''), fSize)) return false
      if (fQty.trim()) {
        const q = parseInt(fQty, 10)
        if (Number.isFinite(q) && r.quantity !== q) return false
      }
      if (fGsm.trim()) {
        const g = parseInt(fGsm, 10)
        if (Number.isFinite(g) && (r.gsm ?? -1) !== g) return false
      }
      return true
    })
  }, [viewRows, fClient, fCoating, fOtherCoating, fEmboss, fPaper, fPo, fCarton, fSize, fQty, fGsm])

  const sorted = useMemo(() => sortLines(filtered, sortKey, sortDir), [filtered, sortKey, sortDir])

  const toggleSort = (k: SortKey) => {
    setSortKey((prev) => {
      if (prev === k) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
        return prev
      }
      setSortDir('asc')
      return k
    })
  }

  const selectedLines = useMemo(
    () => sorted.filter((r) => planningSelection.has(r.id)),
    [sorted, planningSelection],
  )

  const coatingConflict = useMemo(() => {
    if (selectedLines.length < 2) return false
    const c = new Set(selectedLines.map((r) => String(r.coatingType ?? '').trim().toLowerCase()))
    return c.size > 1
  }, [selectedLines])

  const gsmConflict = useMemo(() => {
    if (selectedLines.length < 2) return false
    const g = new Set(selectedLines.map((r) => (r.gsm != null ? String(r.gsm) : '')))
    return g.size > 1
  }, [selectedLines])

  const applyBulk = () => {
    if (selectedLines.length === 0) return
    const upsN = typeof bulkUps === 'number' && bulkUps >= 1 ? bulkUps : null
    const dk =
      bulkDesigner === 'avneet_singh' || bulkDesigner === 'shamsher_inder' ? bulkDesigner : null
    if (!upsN && !dk) {
      toast.error('Set UPS and/or designer to apply')
      return
    }
    for (const r of selectedLines) {
      const spec = (r.specOverrides || {}) as Record<string, unknown>
      const prev = readPlanningCore(spec)
      const sl = Number(r.materialQueue?.sheetLengthMm ?? 0)
      const sw = Number(r.materialQueue?.sheetWidthMm ?? 0)
      const bl = Number(r.carton?.blankLength ?? r.dimLengthMm ?? 0)
      const bw = Number(r.carton?.blankWidth ?? r.dimWidthMm ?? 0)
      const sheetL = sl > 0 ? sl : 1020
      const sheetW = sw > 0 ? sw : 720
      const ups = upsN ?? prev.ups ?? r.materialQueue?.ups ?? 1
      const { yieldPct } =
        bl > 0 && bw > 0
          ? computeSheetUtilization({
              blankLengthMm: bl,
              blankWidthMm: bw,
              sheetLengthMm: sheetL,
              sheetWidthMm: sheetW,
              ups,
            })
          : { yieldPct: 0 }
      updateSpec(r.id, {
        planningCore: {
          ...prev,
          ...(upsN != null
            ? {
                ups,
                actualSheetSizeLabel: sl > 0 && sw > 0 ? formatSheetSizeMm(sl, sw) : prev.actualSheetSizeLabel,
                productionYieldPct: yieldPct,
              }
            : {}),
          ...(dk ? { designerKey: dk } : {}),
        },
      })
    }
    toast.success(`Applied to ${selectedLines.length} row(s)`)
    setBulkOpen(false)
    void Promise.all(selectedLines.map((r) => onSaveRow?.(r.id))).catch(() => {})
  }

  const handlePoPriorityStar = useCallback(
    async (r: PlanningGridLine, e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.stopPropagation()
      if (simulateImpactMode) {
        const cols = numberOfColoursFor(r)
        const bpi = computeBatchProfitabilityIndex({
          quantity: r.quantity,
          ratePerUnitInr: r.rate,
          numberOfColours: cols,
          coatingType: r.coatingType ?? r.carton?.coatingType,
          otherCoating: r.otherCoating ?? r.carton?.laminateType,
        })
        const currentPriorityLines = rows.filter((x) => x.po.isPriority || x.directorPriority).length
        const msg = formatWhatIfPriorityMessage({
          linePoNumber: r.po.poNumber,
          currentPriorityLines,
          bpi,
        })
        toast.info(msg, { duration: 8000 })
        return
      }
      const poId = r.po.id
      const next = r.po.isPriority !== true
      setPriorityBusyPoId(poId)
      try {
        const res = await fetch(`/api/purchase-orders/${poId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isPriority: next }),
        })
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) throw new Error(json.error || 'Could not update priority')
        updateRow(r.id, {
          po: {
            ...r.po,
            isPriority: next,
          },
        })
        broadcastIndustrialPriorityChange({
          source: 'po_is_priority',
          at: new Date().toISOString(),
        })
        toast.success(next ? 'PO marked priority — synced to hubs' : 'PO priority cleared')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Priority update failed')
      } finally {
        setPriorityBusyPoId(null)
      }
    },
    [rows, simulateImpactMode, updateRow],
  )

  const isProcessedRow = (r: PlanningGridLine) => r.planningStatus !== 'pending'

  return (
    <div className="overflow-hidden rounded-lg border border-slate-700 bg-black/35 pb-8 shadow-[0_8px_30px_rgba(0,0,0,0.22)]">
      {mixConflictMessage || coatingConflict || gsmConflict ? (
        <div
          className={`px-3 py-2 text-sm ${flash ? 'bg-red-100 text-red-800 animate-pulse' : 'bg-red-50 text-red-700'}`}
        >
          {mixConflictMessage ??
            (coatingConflict && gsmConflict
              ? 'Mix-Set Conflict: Specs do not match (coating + GSM).'
              : coatingConflict
                ? 'Mix-Set Conflict: Coating values do not match.'
                : 'Mix-Set Conflict: GSM values do not match.')}
        </div>
      ) : null}

      <EnterpriseTableShell>
        <table className="w-full min-w-[2200px] border-collapse text-left text-sm">
          <thead>
            <tr className="bg-slate-900/80 border-b border-slate-800">
              <th
                colSpan={12}
                className="px-2 py-2 text-[11px] font-semibold text-slate-600 uppercase tracking-wide"
              >
                Filters
              </th>
              <th colSpan={6} className="px-2 py-2 text-right align-middle">
                <div className="inline-flex flex-wrap items-center justify-end gap-2">
                  <span className="text-[11px] font-medium text-slate-600">Simulate Impact Mode</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={simulateImpactMode}
                    onClick={() => setSimulateImpactMode((s) => !s)}
                    className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${
                      simulateImpactMode ? 'justify-end bg-[#1D4ED8]' : 'justify-start bg-slate-200'
                    }`}
                    title="When on, the PO priority star runs a what-if only and does not change priority"
                  >
                    <span className="pointer-events-none block h-5 w-5 rounded-full bg-slate-100 shadow" />
                  </button>
                </div>
              </th>
            </tr>
            <tr className="border-b border-slate-800 bg-black/40 text-sm">
              <th className="px-2 py-2 w-10" />
              <th className="px-2 py-2 min-w-[7rem]">
                <input
                  className="h-7 w-full rounded border border-slate-700 bg-slate-950 px-1 text-[11px] text-slate-100"
                  placeholder="PO #"
                  value={fPo}
                  onChange={(e) => setFPo(e.target.value)}
                />
              </th>
              <th className="px-2 py-2 min-w-[6rem]" />
              <th className="px-2 py-2 min-w-[8rem]">
                <select
                  className="h-7 w-full rounded border border-slate-700 bg-slate-950 text-[11px] text-slate-100"
                  value={fClient}
                  onChange={(e) => setFClient(e.target.value)}
                >
                  <option value="">Client</option>
                  {optClients.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </th>
              <th className="px-2 py-2 min-w-[10rem]">
                <input
                  className="h-7 w-full rounded border border-slate-700 bg-slate-950 px-1 text-[11px] text-slate-100"
                  placeholder="Carton name"
                  value={fCarton}
                  onChange={(e) => setFCarton(e.target.value)}
                />
              </th>
              <th className="px-2 py-2" />
              <th className="px-2 py-2 min-w-[6rem]">
                <input
                  className="h-7 w-full rounded border border-slate-700 bg-slate-950 px-1 text-[11px] text-slate-100"
                  placeholder="Size"
                  value={fSize}
                  onChange={(e) => setFSize(e.target.value)}
                />
              </th>
              <th className="px-2 py-2 min-w-[5rem]">
                <input
                  className="h-7 w-full rounded border border-slate-700 bg-slate-950 px-1 text-[11px] text-slate-100"
                  placeholder="Qty"
                  value={fQty}
                  onChange={(e) => setFQty(e.target.value)}
                />
              </th>
              <th className="px-2 py-2" />
              <th className="px-2 py-2" />
              <th className="px-2 py-2 min-w-[7rem]">
                <select
                  className="h-7 w-full rounded border border-slate-700 bg-slate-950 text-[11px] text-slate-100"
                  value={fCoating}
                  onChange={(e) => setFCoating(e.target.value)}
                >
                  <option value="">Coating</option>
                  {optCoating.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </th>
              <th className="px-2 py-2 min-w-[7rem]">
                <select
                  className="h-7 w-full rounded border border-slate-700 bg-slate-950 text-[11px] text-slate-100"
                  value={fOtherCoating}
                  onChange={(e) => setFOtherCoating(e.target.value)}
                >
                  <option value="">Oth coat</option>
                  {optOther.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </th>
              <th className="px-2 py-2 min-w-[7rem]">
                <select
                  className="h-7 w-full rounded border border-slate-700 bg-slate-950 text-[11px] text-slate-100"
                  value={fEmboss}
                  onChange={(e) => setFEmboss(e.target.value)}
                >
                  <option value="">Emb/Leaf</option>
                  {optEmb.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </th>
              <th className="px-2 py-2 min-w-[7rem]">
                <select
                  className="h-7 w-full rounded border border-slate-700 bg-slate-950 text-[11px] text-slate-100"
                  value={fPaper}
                  onChange={(e) => setFPaper(e.target.value)}
                >
                  <option value="">Paper</option>
                  {optPaper.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </th>
              <th className="px-2 py-2 min-w-[4rem]">
                <input
                  className="h-7 w-full rounded border border-slate-700 bg-slate-950 px-1 text-[11px] text-slate-100"
                  placeholder="GSM"
                  value={fGsm}
                  onChange={(e) => setFGsm(e.target.value)}
                />
              </th>
              <th className="px-2 py-2" />
              <th className="px-2 py-2" />
              <th className="px-2 py-2" />
            </tr>
            <tr className="border-b border-slate-800 bg-slate-950">
              <th className={`${cellBase} w-10 bg-[#F8FAFC]`}>
                <span className="text-[11px] font-medium text-slate-600">Si</span>
              </th>
              <th className={`${cellBase} bg-slate-950 min-w-[7rem]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('poNumber')}>
                  PO No. {sortKey === 'poNumber' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950 min-w-[6rem]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('poDate')}>
                  PO Date {sortKey === 'poDate' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('client')}>
                  Client {sortKey === 'client' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950 min-w-[10rem]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('cartonName')}>
                  Carton {sortKey === 'cartonName' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('artworkCode')}>
                  AW Code {sortKey === 'artworkCode' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('cartonSize')}>
                  Carton Size {sortKey === 'cartonSize' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('qty')}>
                  Qty {sortKey === 'qty' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('dyeUps')}>
                  Dye/UPS {sortKey === 'dyeUps' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('sheetSize')}>
                  Sheet Size {sortKey === 'sheetSize' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('coating')}>
                  Coating {sortKey === 'coating' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('otherCoating')}>
                  Oth coat {sortKey === 'otherCoating' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('emboss')}>
                  Emb/Leaf {sortKey === 'emboss' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('paper')}>
                  Paper {sortKey === 'paper' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('gsm')}>
                  GSM {sortKey === 'gsm' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('ups')}>
                  UPS {sortKey === 'ups' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('remarks')}>
                  Remarks {sortKey === 'remarks' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-slate-950 text-right`}>Action</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, idx) => {
              const spec = (r.specOverrides || {}) as Record<string, unknown>
              const planCore = readPlanningCore(spec)
              const aw = artworkCodeFor(r) || '—'
              const otherCoat = r.otherCoating ?? r.carton?.laminateType ?? '—'
              const coating = r.coatingType ?? r.carton?.coatingType ?? '—'
              const processed = isProcessedRow(r)
              const stripe = idx % 2 === 0 ? 'bg-[#0B0F1A]' : 'bg-[#161B26]'
              const bpiRow = computeBatchProfitabilityIndex({
                quantity: r.quantity,
                ratePerUnitInr: r.rate,
                numberOfColours: numberOfColoursFor(r),
                coatingType: r.coatingType ?? r.carton?.coatingType,
                otherCoating: r.otherCoating ?? r.carton?.laminateType,
              })

              return (
                <Fragment key={r.id}>
                  <tr
                    className={`${stripe} h-12 max-h-12 transition-colors hover:brightness-110`}
                    onClick={(e) => {
                      const t = e.target as HTMLElement
                      if (t.closest('input,select,button,a,[data-po-priority-star]')) return
                      onRowBackgroundClick(r.id)
                    }}
                  >
                    <td className={`${cellBase} w-10 text-center`} onClick={(e) => e.stopPropagation()}>
                      {processed ? (
                        <button
                          type="button"
                          title="Recall from AW queue"
                          className="inline-flex h-8 w-8 items-center justify-center rounded border border-amber-500 text-amber-300 hover:bg-amber-500/10"
                          onClick={() => void onRecallLine(r.id)}
                        >
                          <RotateCcw className="h-4 w-4" aria-hidden />
                        </button>
                      ) : (
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[#1D4ED8]"
                          checked={planningSelection.has(r.id)}
                          onChange={() => {
                            setPlanningSelection((prev) => {
                              const next = new Set(prev)
                              if (next.has(r.id)) next.delete(r.id)
                              else next.add(r.id)
                              return next
                            })
                          }}
                          aria-label="Select row"
                        />
                      )}
                    </td>
                    <td className={cellBase} title={r.po.poNumber}>
                      <div className="flex min-w-0 items-center gap-0.5">
                        <button
                          type="button"
                          data-po-priority-star
                          disabled={priorityBusyPoId === r.po.id}
                          title={
                            r.po.isPriority === true
                              ? simulateImpactMode
                                ? 'Simulate impact of clearing PO priority'
                                : 'Clear PO priority (pin)'
                              : simulateImpactMode
                                ? 'Simulate impact of marking PO priority'
                                : 'Mark PO priority (pin to top)'
                          }
                          aria-label={
                            r.po.isPriority === true
                              ? 'Clear PO priority'
                              : 'Mark PO priority'
                          }
                          className="inline-flex shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-amber-400 disabled:opacity-40"
                          onClick={(e) => void handlePoPriorityStar(r, e)}
                        >
                          <Star
                            className={`h-3.5 w-3.5 shrink-0 ${
                              r.po.isPriority === true ? INDUSTRIAL_PRIORITY_STAR_ICON_CLASS : ''
                            }`}
                            aria-hidden
                          />
                        </button>
                        <Link
                          href={`/orders/purchase-orders/${r.po.id}`}
                          className={`${monoStrong} min-w-0 truncate text-amber-300 hover:underline`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.po.poNumber}
                        </Link>
                      </div>
                    </td>
                    <td className={`${cellBase} ${monoStrong}`} title={r.po.poDate}>
                      {r.po.poDate?.slice(0, 10) ?? '—'}
                    </td>
                    <td className={`${cellBase} overflow-visible`}>
                      <TruncatedWithTooltip value={r.po?.customer?.name ?? '—'} />
                    </td>
                    <td className={`${cellBase} overflow-visible`}>
                      {r.cartonId ? (
                        <Link
                          href={`/product/${r.cartonId}`}
                          className="text-amber-300 hover:underline font-medium"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <TruncatedWithTooltip value={r.cartonName ?? '—'} />
                        </Link>
                      ) : (
                        <TruncatedWithTooltip value={r.cartonName ?? '—'} />
                      )}
                    </td>
                    <td className={`${cellBase} ${monoStrong}`} title={aw}>
                      {aw}
                    </td>
                    <td className={cellBase} title={String(r.cartonSize ?? '')}>
                      {r.cartonSize ?? '—'}
                    </td>
                    <td className={`${cellBase} ${monoStrong}`} title={String(r.quantity)}>
                      <div className="flex flex-wrap items-center gap-1">
                        <span>{r.quantity.toLocaleString('en-IN')}</span>
                        {bpiRow ? (
                          <span
                            title={bpiRow.tooltip}
                            className={`inline-flex max-w-full shrink-0 rounded-full px-1.5 py-0 text-[10px] font-semibold leading-tight ${
                              bpiRow.label === 'optimal'
                                ? 'bg-green-100 text-green-700'
                                : 'bg-amber-100 text-amber-700'
                            }`}
                          >
                            {bpiRow.label === 'optimal' ? '[Optimal]' : '[Loss-Leader]'}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td
                      className={`${cellBase} ${!r.dieMaster ? 'text-amber-600 font-semibold' : ''}`}
                      title={dyeUpsDisplay(r)}
                    >
                      {dyeUpsDisplay(r)}
                    </td>
                    <td className={cellBase} title={sheetSizeLabel(r, spec)}>
                      {sheetSizeLabel(r, spec)}
                    </td>
                    <td
                      className={`${cellBase} max-w-[12rem]`}
                      title={String(coating)}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {processed ? (
                        coating
                      ) : (
                        <PackagingEnumCombobox
                          aria-label="Coating"
                          options={MASTER_COATINGS_AND_VARNISHES}
                          value={r.coatingType ?? r.carton?.coatingType ?? null}
                          onChange={(v) => {
                            updateRow(r.id, { coatingType: v })
                            void onSaveRow?.(r.id)
                          }}
                          className="max-w-[11rem]"
                        />
                      )}
                    </td>
                    <td
                      className={`${cellBase} max-w-[12rem]`}
                      title={String(otherCoat)}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {processed ? (
                        otherCoat
                      ) : (
                        <PackagingEnumCombobox
                          aria-label="Secondary coating / laminate"
                          options={MASTER_COATINGS_AND_VARNISHES}
                          value={r.otherCoating ?? r.carton?.laminateType ?? null}
                          onChange={(v) => {
                            updateRow(r.id, { otherCoating: v })
                            void onSaveRow?.(r.id)
                          }}
                          className="max-w-[11rem]"
                        />
                      )}
                    </td>
                    <td
                      className={`${cellBase} max-w-[12rem]`}
                      title={String(r.embossingLeafing ?? '')}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {processed ? (
                        r.embossingLeafing ?? '—'
                      ) : (
                        <PackagingEnumCombobox
                          aria-label="Embossing and leafing"
                          options={MASTER_EMBOSSING_AND_LEAFING}
                          value={r.embossingLeafing}
                          onChange={(v) => {
                            updateRow(r.id, { embossingLeafing: v })
                            void onSaveRow?.(r.id)
                          }}
                          className="max-w-[11rem]"
                        />
                      )}
                    </td>
                    <td
                      className={`${cellBase} max-w-[12rem]`}
                      title={String(r.paperType ?? '')}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {processed ? (
                        r.paperType ?? '—'
                      ) : (
                        <PackagingEnumCombobox
                          aria-label="Paper / board type"
                          options={MASTER_BOARD_GRADES}
                          value={r.paperType}
                          onChange={(v) => {
                            updateRow(r.id, { paperType: v })
                            void onSaveRow?.(r.id)
                          }}
                          className="max-w-[11rem]"
                        />
                      )}
                    </td>
                    <td className={cellBase} title={r.gsm != null ? String(r.gsm) : ''}>
                      {r.gsm ?? '—'}
                    </td>
                    <td className={cellBase} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="number"
                        min={1}
                        disabled={processed}
                        className="h-8 min-w-[80px] w-[4.5rem] rounded border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100 disabled:opacity-50"
                        value={planCore.ups ?? r.materialQueue?.ups ?? ''}
                        onChange={(e) => {
                          const ups = Math.max(1, parseInt(e.target.value, 10) || 1)
                          const prev = readPlanningCore(spec)
                          const sl = Number(r.materialQueue?.sheetLengthMm ?? 0)
                          const sw = Number(r.materialQueue?.sheetWidthMm ?? 0)
                          const bl = Number(r.carton?.blankLength ?? r.dimLengthMm ?? 0)
                          const bw = Number(r.carton?.blankWidth ?? r.dimWidthMm ?? 0)
                          const sheetL = sl > 0 ? sl : 1020
                          const sheetW = sw > 0 ? sw : 720
                          const { yieldPct } =
                            bl > 0 && bw > 0
                              ? computeSheetUtilization({
                                  blankLengthMm: bl,
                                  blankWidthMm: bw,
                                  sheetLengthMm: sheetL,
                                  sheetWidthMm: sheetW,
                                  ups,
                                })
                              : { yieldPct: 0 }
                          updateSpec(r.id, {
                            planningCore: {
                              ...prev,
                              ups,
                              actualSheetSizeLabel:
                                sl > 0 && sw > 0 ? formatSheetSizeMm(sl, sw) : undefined,
                              productionYieldPct: yieldPct,
                            },
                          })
                        }}
                        onBlur={() => void onSaveRow?.(r.id)}
                      />
                    </td>
                    <td className={cellBase} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        disabled={processed}
                        className="h-8 w-full min-w-[80px] max-w-[12rem] rounded border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100 disabled:opacity-50"
                        value={r.remarks ?? ''}
                        onChange={(e) => updateRow(r.id, { remarks: e.target.value || null })}
                        onBlur={() => void onSaveRow?.(r.id)}
                      />
                    </td>
                    <td className={`${cellBase} text-right`} onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="text-rose-500 hover:text-rose-600 text-[13px] font-medium"
                        onClick={() => onRemoveLine(r)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </EnterpriseTableShell>

      {sorted.length === 0 ? (
        <p className="px-4 py-6 text-center text-slate-500 text-sm">No lines in this view.</p>
      ) : null}

      {planningSelection.size >= 1 ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[75] flex -translate-x-1/2 flex-col items-center gap-2">
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-4 py-2 shadow-lg">
            <button
              type="button"
              onClick={onLinkAsMixSet}
              disabled={planningSelection.size < 2}
              className="rounded-full border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Group as Mix-Set
            </button>
            <button
              type="button"
              onClick={() => setBulkOpen(true)}
              className="rounded-full bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500"
            >
              Bulk Apply UPS
            </button>
          </div>
        </div>
      ) : null}

      {bulkOpen ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-xl">
            <h3 className="text-sm font-semibold text-slate-100">Bulk apply</h3>
            <p className="text-xs text-slate-500 mt-1">Applies to {selectedLines.length} selected row(s).</p>
            <label className="mt-3 block text-xs font-medium text-slate-400">
              UPS
              <input
                type="number"
                min={1}
                className="mt-1 w-full h-9 rounded border border-slate-700 bg-slate-950 px-2 text-slate-100"
                value={bulkUps}
                onChange={(e) => setBulkUps(e.target.value === '' ? '' : Math.max(1, parseInt(e.target.value, 10) || 1))}
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-400">
              Designer
              <select
                className="mt-1 w-full h-9 rounded border border-slate-700 bg-slate-950 px-2 text-slate-100"
                value={bulkDesigner}
                onChange={(e) => setBulkDesigner(e.target.value as PlanningDesignerKey | '')}
              >
                <option value="">—</option>
                <option value="avneet_singh">Avneet Singh</option>
                <option value="shamsher_inder">Shamsher Inder</option>
              </select>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-lg px-3 py-1.5 text-sm text-slate-300" onClick={() => setBulkOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-500"
                onClick={applyBulk}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
