'use client'

import { Fragment, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
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
const cellBase =
  'align-middle text-[13px] font-medium text-slate-200 border-b border-[#334155] px-1.5 py-2'
const cellMono =
  'font-designing-queue text-[13px] font-semibold tabular-nums text-[#FBBF24]'
const theadBtn =
  'inline-flex w-full min-w-0 items-center gap-0.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-[#FBBF24]'
const filterGhost =
  'w-full min-w-0 bg-transparent text-[13px] font-medium text-slate-200 placeholder:text-slate-500 border-0 border-b border-[#334155] rounded-none px-0 py-1.5 focus:outline-none focus:ring-0 focus:border-b-2 focus:border-[#2563EB]'

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
    paperType?: string | null
    gsm?: number | null
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
      case 'gsm': {
        const ga = a.gsm ?? a.carton?.gsm ?? 0
        const gb = b.gsm ?? b.carton?.gsm ?? 0
        cmp = ga - gb
        break
      }
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
  onPONumberClick,
  onCartonClick,
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
  onPONumberClick: (poId: string) => void
  onCartonClick: (line: PlanningGridLine) => void
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
  const [fDate, setFDate] = useState('')
  const [fAw, setFAw] = useState('')
  const [fDye, setFDye] = useState('')
  const [fSheet, setFSheet] = useState('')
  const [fRem, setFRem] = useState('')

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

  const filtered = useMemo(() => {
    const match = (hay: string, needle: string) =>
      !needle.trim() || hay.toLowerCase().includes(needle.trim().toLowerCase())
    return viewRows.filter((r) => {
      if (!match(r.po?.customer?.name ?? '', fClient)) return false
      if (!match(String(r.coatingType ?? ''), fCoating)) return false
      if (!match(String(r.otherCoating ?? ''), fOtherCoating)) return false
      if (!match(String(r.embossingLeafing ?? ''), fEmboss)) return false
      if (!match(String(r.paperType ?? ''), fPaper)) return false
      if (!match(r.po?.poNumber ?? '', fPo)) return false
      if (!match(String(r.po?.poDate ?? '').slice(0, 10), fDate)) return false
      if (!match(r.cartonName ?? '', fCarton)) return false
      if (!match(String(artworkCodeFor(r)), fAw)) return false
      if (!match(String(r.cartonSize ?? ''), fSize)) return false
      if (!match(dyeUpsDisplay(r), fDye)) return false
      if (!match(sheetSizeLabel(r, (r.specOverrides || {}) as Record<string, unknown>), fSheet)) return false
      if (!match(String(r.remarks ?? ''), fRem)) return false
      if (fQty.trim()) {
        const q = parseInt(fQty, 10)
        if (Number.isFinite(q) && r.quantity !== q) return false
      }
      if (fGsm.trim()) {
        const g = parseInt(fGsm, 10)
        const eff = r.gsm ?? r.carton?.gsm ?? null
        if (Number.isFinite(g) && (eff ?? -1) !== g) return false
      }
      return true
    })
  }, [
    viewRows,
    fClient,
    fCoating,
    fOtherCoating,
    fEmboss,
    fPaper,
    fPo,
    fDate,
    fCarton,
    fAw,
    fSize,
    fDye,
    fSheet,
    fRem,
    fQty,
    fGsm,
  ])

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
    const c = new Set(
      selectedLines.map((r) =>
        String(r.coatingType ?? r.carton?.coatingType ?? '')
          .trim()
          .toLowerCase(),
      ),
    )
    return c.size > 1
  }, [selectedLines])

  const gsmConflict = useMemo(() => {
    if (selectedLines.length < 2) return false
    const g = new Set(
      selectedLines.map((r) =>
        String(r.gsm ?? r.carton?.gsm ?? ''),
      ),
    )
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[#334155] bg-[#0F172A] shadow-[0_8px_30px_rgba(0,0,0,0.22)]">
      {mixConflictMessage || coatingConflict || gsmConflict ? (
        <div
          className={`px-3 py-2 text-sm ${
            flash ? 'bg-rose-900/80 text-rose-100 animate-pulse' : 'bg-rose-950/60 text-rose-200'
          }`}
        >
          {mixConflictMessage ??
            (coatingConflict && gsmConflict
              ? 'Mix-Set Conflict: Specs do not match (coating + GSM).'
              : coatingConflict
                ? 'Mix-Set Conflict: Coating values do not match.'
                : 'Mix-Set Conflict: GSM values do not match.')}
        </div>
      ) : null}

      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-[#334155] bg-[#0F172A] px-2 py-1.5">
        <span className="text-[11px] font-medium text-slate-500">Simulate Impact Mode</span>
        <button
          type="button"
          role="switch"
          aria-checked={simulateImpactMode}
          onClick={() => setSimulateImpactMode((s) => !s)}
          className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${
            simulateImpactMode ? 'justify-end bg-[#2563EB]' : 'justify-start bg-[#1E293B]'
          }`}
          title="When on, the PO priority star runs a what-if only and does not change priority"
        >
          <span className="pointer-events-none block h-5 w-5 rounded-full bg-white shadow" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <table className="w-full table-fixed border-collapse text-left">
          <colgroup>
            <col className="w-[50px]" />
            <col className="w-[7%]" />
            <col className="w-[5%]" />
            <col className="w-[9%]" />
            <col className="w-[11%]" />
            <col className="w-[6%]" />
            <col className="w-[5%]" />
            <col className="w-[80px]" />
            <col className="w-[5%]" />
            <col className="w-[5%]" />
            <col className="w-[5%]" />
            <col className="w-[5%]" />
            <col className="w-[5%]" />
            <col className="w-[5%]" />
            <col className="w-[60px]" />
            <col className="w-[60px]" />
            <col className="w-[8%]" />
            <col className="w-[52px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-[#334155] bg-[#1E293B]">
              <th
                className={`${cellBase} sticky left-0 z-20 w-[50px] min-w-[50px] max-w-[50px] bg-white text-center text-[#0F172A]`}
              >
                <span className="text-[11px] font-bold">Si</span>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('poNumber')}>
                  PO No. {sortKey === 'poNumber' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('poDate')}>
                  PO Date {sortKey === 'poDate' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('client')}>
                  Client {sortKey === 'client' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} min-w-0 bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('cartonName')}>
                  Carton {sortKey === 'cartonName' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('artworkCode')}>
                  AW {sortKey === 'artworkCode' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('cartonSize')}>
                  Size {sortKey === 'cartonSize' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} w-[80px] bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('qty')}>
                  Qty {sortKey === 'qty' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('dyeUps')}>
                  Dye/UPS {sortKey === 'dyeUps' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('sheetSize')}>
                  Sheet {sortKey === 'sheetSize' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('coating')}>
                  Coating {sortKey === 'coating' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('otherCoating')}>
                  Oth {sortKey === 'otherCoating' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('emboss')}>
                  Emb {sortKey === 'emboss' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('paper')}>
                  Paper {sortKey === 'paper' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} w-[60px] bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('gsm')}>
                  GSM {sortKey === 'gsm' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} w-[60px] bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('ups')}>
                  UPS {sortKey === 'ups' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} min-w-0 bg-[#1E293B]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('remarks')}>
                  Rem {sortKey === 'remarks' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} bg-[#1E293B] text-right`}> </th>
            </tr>
            <tr className="border-b border-[#334155] bg-[#0F172A] text-[13px]">
              <th
                className={`sticky left-0 z-20 w-[50px] bg-white px-0 py-1 align-middle text-[#0F172A] ${cellBase}`}
              />
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter PO No…"
                  value={fPo}
                  onChange={(e) => setFPo(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter PO Date…"
                  value={fDate}
                  onChange={(e) => setFDate(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Client…"
                  value={fClient}
                  onChange={(e) => setFClient(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="min-w-0 px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Carton…"
                  value={fCarton}
                  onChange={(e) => setFCarton(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter AW…"
                  value={fAw}
                  onChange={(e) => setFAw(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Size…"
                  value={fSize}
                  onChange={(e) => setFSize(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="w-[80px] px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Qty…"
                  value={fQty}
                  onChange={(e) => setFQty(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Dye…"
                  value={fDye}
                  onChange={(e) => setFDye(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Sheet…"
                  value={fSheet}
                  onChange={(e) => setFSheet(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Coating…"
                  value={fCoating}
                  onChange={(e) => setFCoating(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Oth…"
                  value={fOtherCoating}
                  onChange={(e) => setFOtherCoating(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Emb…"
                  value={fEmboss}
                  onChange={(e) => setFEmboss(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Paper…"
                  value={fPaper}
                  onChange={(e) => setFPaper(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="w-[60px] px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter GSM…"
                  value={fGsm}
                  onChange={(e) => setFGsm(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="w-[60px] px-0 py-1 align-bottom" />
              <th className="min-w-0 px-1 py-1 align-bottom">
                <input
                  className={filterGhost}
                  placeholder="Filter Rem…"
                  value={fRem}
                  onChange={(e) => setFRem(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-0 py-1" />
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
              const coatMaster = Boolean(String(r.carton?.coatingType ?? '').trim())
              const lamMaster = Boolean(String(r.carton?.laminateType ?? '').trim())
              const paperMaster = Boolean(String(r.carton?.paperType ?? '').trim())

              return (
                <Fragment key={r.id}>
                  <tr
                    className={`${stripe} transition-colors hover:brightness-110`}
                    onClick={(e) => {
                      const t = e.target as HTMLElement
                      if (t.closest('input,select,button,a,[data-po-priority-star]')) return
                      onRowBackgroundClick(r.id)
                    }}
                  >
                    <td
                      className={`sticky left-0 z-10 w-[50px] min-w-[50px] max-w-[50px] border-b border-[#334155] bg-white px-0.5 py-1.5 text-center align-middle text-[#0F172A]`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex flex-col items-center justify-center gap-0.5">
                        <span className="text-[11px] font-bold leading-none">{idx + 1}</span>
                        {processed ? (
                          <button
                            type="button"
                            title="Recall from AW queue"
                            className="inline-flex h-6 w-6 items-center justify-center rounded border border-[#334155] text-[#0F172A] hover:bg-slate-100"
                            onClick={() => void onRecallLine(r.id)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        ) : (
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-[#2563EB]"
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
                      </div>
                    </td>
                    <td className={`${cellBase} min-w-0 align-middle`} title={r.po.poNumber}>
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
                          className="inline-flex shrink-0 rounded p-0.5 text-slate-500 hover:bg-[#1E293B] hover:text-[#F59E0B] disabled:opacity-40"
                          onClick={(e) => void handlePoPriorityStar(r, e)}
                        >
                          <Star
                            className={`h-3.5 w-3.5 shrink-0 ${
                              r.po.isPriority === true ? INDUSTRIAL_PRIORITY_STAR_ICON_CLASS : ''
                            }`}
                            aria-hidden
                          />
                        </button>
                        <button
                          type="button"
                          className={`${cellMono} min-w-0 truncate text-left text-[#FBBF24] hover:underline`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onPONumberClick(r.po.id)
                          }}
                        >
                          {r.po?.poNumber ?? '—'}
                        </button>
                      </div>
                    </td>
                    <td className={`${cellBase} ${cellMono} align-middle`} title={r.po.poDate}>
                      {r.po?.poDate?.slice(0, 10) ?? '—'}
                    </td>
                    <td
                      className={`${cellBase} min-w-0 max-w-0 align-middle text-[13px] font-medium leading-snug text-slate-200`}
                    >
                      <div className="whitespace-normal break-words">{r.po?.customer?.name ?? '—'}</div>
                    </td>
                    <td
                      className={`${cellBase} min-w-0 max-w-0 align-middle text-[13px] font-medium leading-snug text-slate-200`}
                    >
                      <button
                        type="button"
                        className="w-full text-left text-[#FBBF24] hover:underline"
                        disabled={!r.cartonId}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (r.cartonId) onCartonClick(r)
                        }}
                      >
                        <span className="whitespace-normal break-words">
                          {r.cartonName ?? '—'}
                        </span>
                      </button>
                    </td>
                    <td className={`${cellBase} ${cellMono} align-middle`} title={aw}>
                      {aw}
                    </td>
                    <td className={`${cellBase} align-middle`} title={String(r.cartonSize ?? '')}>
                      {r.cartonSize ?? '—'}
                    </td>
                    <td className={`${cellBase} w-[80px] ${cellMono} align-middle`} title={String(r.quantity)}>
                      <div className="flex flex-col items-stretch gap-0.5">
                        <span>{r.quantity.toLocaleString('en-IN')}</span>
                        {bpiRow ? (
                          <span
                            title={bpiRow.tooltip}
                            className={`inline-flex max-w-full shrink-0 rounded px-1 py-0 text-[10px] font-semibold leading-tight ${
                              bpiRow.label === 'optimal' ? 'text-[#34D399]' : 'text-amber-400'
                            }`}
                          >
                            {bpiRow.label === 'optimal' ? 'Ready' : 'Watch'}
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
                          disabled={coatMaster}
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
                          disabled={lamMaster}
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
                          value={r.paperType ?? r.carton?.paperType ?? null}
                          onChange={(v) => {
                            updateRow(r.id, { paperType: v })
                            void onSaveRow?.(r.id)
                          }}
                          className="max-w-[11rem]"
                          disabled={paperMaster}
                        />
                      )}
                    </td>
                    <td className={`${cellBase} w-[60px] ${cellMono} align-middle`} title={String(r.gsm ?? r.carton?.gsm ?? '')}>
                      {r.gsm ?? r.carton?.gsm ?? '—'}
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
        {sorted.length === 0 ? (
          <p className="px-4 py-6 text-center text-slate-500 text-sm">No lines in this view.</p>
        ) : null}
      </div>

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
