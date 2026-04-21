'use client'

import { Info, X } from 'lucide-react'
import {
  computeFivePointReadiness,
  computeToolingInterlock,
  type MaterialGate,
  type MaterialGateStatus,
} from '@/lib/planning-interlock'
import {
  computeSheetUtilization,
  PLANNING_DESIGNERS,
  readPlanningCore,
  type PlanningDesignerKey,
} from '@/lib/planning-decision-spec'
import {
  computeMakeReadySheetsBreakdown,
  hasSpecialCoatingForPlanning,
} from '@/lib/planning-predictive'
import type { ReadinessFiveSegment } from '@/lib/planning-interlock'

const mono = 'font-designing-queue tabular-nums tracking-tight'

function FiveStrip({ segments }: { segments: ReadinessFiveSegment[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Readiness ledger AW · PA · DI · EB · SC">
      {segments.map((s) => {
        const green = s.state === 'ready'
        const grey = s.state === 'neutral'
        const blocked = s.state === 'blocked'
        const stateClass = green
          ? 'pharma-readiness-badge--ready'
          : grey
            ? 'pharma-readiness-badge--neutral'
            : 'pharma-readiness-badge--blocked'
        return (
          <span key={s.key} title={s.title} className={`pharma-readiness-badge ${stateClass}`}>
            {s.abbr}
          </span>
        )
      })}
    </div>
  )
}

/** Upper semi-circle gauge for sheet utilization (0–100%). */
function SemiGaugeUtilization({ pct }: { pct: number }) {
  const p = Math.min(100, Math.max(0, Math.round(pct * 10) / 10))
  const r = 18
  const arcLen = Math.PI * r
  const dash = (p / 100) * arcLen
  const stroke =
    p >= 85 ? 'stroke-emerald-500' : p >= 60 ? 'stroke-amber-500' : 'stroke-rose-500'
  return (
    <div className="flex flex-col items-center gap-1" aria-hidden>
      <svg viewBox="0 0 48 28" className="h-16 w-28">
        <path
          d="M 6 24 A 18 18 0 0 1 42 24"
          fill="none"
          className="stroke-zinc-200 dark:stroke-zinc-800"
          strokeWidth="4"
        />
        <path
          d="M 6 24 A 18 18 0 0 1 42 24"
          fill="none"
          className={stroke}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${arcLen}`}
        />
      </svg>
      <span className={`${mono} text-[11px] font-semibold text-[#1A1A1B] dark:text-slate-200`}>{p}%</span>
    </div>
  )
}

function RingPct({
  label,
  pct,
  tone,
}: {
  label: string
  pct: number
  tone: 'emerald' | 'amber' | 'rose' | 'slate'
}) {
  const p = Math.min(100, Math.max(0, Math.round(pct * 10) / 10))
  const r = 18
  const c = 2 * Math.PI * r
  const dash = (p / 100) * c
  const stroke =
    tone === 'emerald'
      ? 'stroke-emerald-500'
      : tone === 'amber'
        ? 'stroke-amber-500'
        : tone === 'rose'
          ? 'stroke-rose-500'
          : 'stroke-slate-500'
  return (
    <div className="flex flex-col items-center gap-1 min-w-[4.5rem]">
      <div className="relative h-14 w-14" aria-hidden>
        <svg viewBox="0 0 48 48" className="h-full w-full -rotate-90">
          <circle cx="24" cy="24" r={r} fill="none" className="stroke-zinc-200 dark:stroke-zinc-800" strokeWidth="4" />
          <circle
            cx="24"
            cy="24"
            r={r}
            fill="none"
            className={stroke}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`}
          />
        </svg>
        <div
          className={`pointer-events-none absolute inset-0 flex items-center justify-center ${mono} text-[10px] font-semibold text-[#1A1A1B] dark:text-slate-200`}
        >
          {p}%
        </div>
      </div>
      <span className="text-[8px] uppercase tracking-wide text-slate-600 dark:text-slate-500 text-center leading-tight">
        {label}
      </span>
    </div>
  )
}

function normalizeMaterialGate(raw: Partial<MaterialGate> | undefined): MaterialGate {
  const s = String(raw?.status ?? 'unknown')
  const status: MaterialGateStatus =
    s === 'available' || s === 'ordered' || s === 'shortage' || s === 'unknown' ? s : 'unknown'
  return {
    status,
    requiredSheets: raw?.requiredSheets ?? null,
    netAvailable: raw?.netAvailable ?? null,
    procurementStatus: raw?.procurementStatus ?? '',
  }
}

type DrawerLine = {
  id: string
  cartonName: string
  quantity: number
  coatingType?: string | null
  otherCoating?: string | null
  embossingLeafing: string | null
  shadeCardId?: string | null
  shadeCard?: {
    custodyStatus: string
    mfgDate: string | null
    approvalDate: string | null
    createdAt: string
    isActive: boolean
  } | null
  specOverrides: Record<string, unknown> | null
  readiness?: {
    artworkLocksCompleted: number
    platesStatus: string
    dieStatus: string
  }
  planningLedger?: {
    materialGate: Partial<MaterialGate> | MaterialGate
    numberOfColours?: number | null
  } | null
  materialQueue?: {
    totalSheets: number
    ups?: number
    sheetLengthMm?: unknown
    sheetWidthMm?: unknown
  } | null
  carton?: {
    blankLength?: unknown
    blankWidth?: unknown
    laminateType?: string | null
    coatingType?: string | null
    numberOfColours?: number | null
  } | null
  po?: { poNumber: string; customer: { name: string } }
}

function shadeForInterlock(r: DrawerLine) {
  if (!r.shadeCard) return null
  const c = r.shadeCard
  return {
    custodyStatus: c.custodyStatus,
    mfgDate: c.mfgDate ? new Date(c.mfgDate) : null,
    approvalDate: c.approvalDate ? new Date(c.approvalDate) : null,
    createdAt: new Date(c.createdAt),
    isActive: c.isActive,
  }
}

export function PlanningReadinessDrawer({
  open,
  line,
  onClose,
  onDesignerKeyChange,
}: {
  open: boolean
  line: DrawerLine | null
  onClose: () => void
  /** Persist designer from drawer back to planning row */
  onDesignerKeyChange?: (lineId: string, key: PlanningDesignerKey | '') => void
}) {
  if (!open || !line) return null

  const spec = line.specOverrides || {}
  const pc = readPlanningCore(spec)
  const artworkLocks = Number(spec.artworkLocksCompleted ?? line.readiness?.artworkLocksCompleted ?? 0)
  const platesStatus = String(spec.platesStatus ?? line.readiness?.platesStatus ?? 'new_required')
  const dieStatus = String(spec.dieStatus ?? line.readiness?.dieStatus ?? 'not_available')
  const embossStatus = String(spec.embossStatus ?? 'vendor_ordered')

  const mg = normalizeMaterialGate(line.planningLedger?.materialGate)

  const five = computeFivePointReadiness({
    artworkLocksCompleted: artworkLocks,
    platesStatus,
    materialGate: mg,
    dieStatus,
    embossingLeafing: line.embossingLeafing,
    embossStatus,
    shadeCardId: line.shadeCardId ?? null,
    shadeCard: shadeForInterlock(line),
  })

  const ti = computeToolingInterlock({
    platesStatus,
    dieStatus,
    embossingLeafing: line.embossingLeafing,
    embossStatus,
    shadeCardId: line.shadeCardId,
    shadeCard: shadeForInterlock(line),
  })

  const awPct = artworkLocks >= 2 ? 100 : (artworkLocks / 2) * 100
  const platePct =
    platesStatus === 'available' ? 100 : platesStatus === 'partial' ? 50 : 0
  const diePct = dieStatus === 'good' ? 100 : dieStatus === 'attention' ? 45 : 0
  const rmPct =
    mg.status === 'available' ? 100 : mg.status === 'ordered' ? 55 : mg.status === 'shortage' ? 0 : 25

  const awTone = awPct >= 100 ? 'emerald' : awPct >= 50 ? 'amber' : 'rose'
  const plTone = platePct >= 100 ? 'emerald' : platePct >= 50 ? 'amber' : 'rose'
  const diTone = diePct >= 100 ? 'emerald' : diePct >= 45 ? 'amber' : 'rose'
  const rmTone = rmPct >= 100 ? 'emerald' : rmPct >= 55 ? 'amber' : 'rose'

  const specColours = typeof spec.numberOfColours === 'number' ? spec.numberOfColours : null
  const nColours = specColours ?? line.planningLedger?.numberOfColours ?? line.carton?.numberOfColours ?? 4
  const coat = line.coatingType ?? line.carton?.coatingType
  const oth = line.otherCoating ?? line.carton?.laminateType
  const makeReady = computeMakeReadySheetsBreakdown({
    numberOfColours: nColours,
    hasSpecialCoating: hasSpecialCoatingForPlanning(coat, oth),
  })
  const bl = Number(line.carton?.blankLength ?? 0)
  const bw = Number(line.carton?.blankWidth ?? 0)
  const sl = Number(line.materialQueue?.sheetLengthMm ?? 0)
  const sw = Number(line.materialQueue?.sheetWidthMm ?? 0)
  const upsDraw = pc.ups ?? line.materialQueue?.ups ?? 1
  const util =
    bl > 0 && bw > 0 && sl > 0 && sw > 0
      ? computeSheetUtilization({
          blankLengthMm: bl,
          blankWidthMm: bw,
          sheetLengthMm: sl,
          sheetWidthMm: sw,
          ups: upsDraw,
        })
      : null

  return (
    <div className="fixed inset-0 z-[90] flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/20 backdrop-blur-[2px]"
        aria-label="Close"
        onClick={onClose}
      />
      <aside
        className="relative h-full w-full max-w-md border-l border-pharma-border bg-pharma-surface flex flex-col dark:border-slate-700 dark:bg-slate-900 shadow-[-4px_0_24px_rgba(0,0,0,0.05)]"
      >
        <div className="flex items-start justify-between gap-2 border-b border-[#E2E8F0] dark:border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <p className="font-id-mono text-xs text-amber-700 dark:text-amber-400 truncate">
              PO {line.po?.poNumber ?? '—'}
            </p>
            <h2 className="text-sm font-semibold text-[#1A1A1B] dark:text-slate-100 truncate pr-2">{line.cartonName}</h2>
            <p className="text-[10px] text-slate-500 mt-0.5 truncate max-w-[18rem]">
              {line.po?.customer?.name ?? '—'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close drawer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-4 overflow-y-auto flex-1">
          <div>
            <p className={`text-[10px] uppercase tracking-wide text-slate-500 ${mono}`}>Readiness ledger</p>
            <div className="mt-2">
              <FiveStrip segments={five.segments} />
            </div>
          </div>

          <div>
            <p className={`text-[10px] uppercase tracking-wide text-slate-500 ${mono}`}>Quick assign designer</p>
            <select
              value={pc.designerKey ?? ''}
              onChange={(e) => {
                const v = e.target.value
                const key =
                  v === 'avneet_singh' || v === 'shamsher_inder' ? (v as PlanningDesignerKey) : ''
                onDesignerKeyChange?.(line.id, key)
              }}
              className={`mt-1 w-full h-9 rounded border border-border bg-card px-2 text-xs text-foreground dark:border-border/40 dark:bg-card dark:text-slate-200 ${mono}`}
            >
              <option value="">— Designer —</option>
              {(Object.entries(PLANNING_DESIGNERS) as [PlanningDesignerKey, string][]).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className={`text-[10px] uppercase tracking-wide text-slate-500 ${mono}`}>Summary</p>
            <ul className={`mt-1 space-y-1 text-[11px] text-slate-700 dark:text-slate-300 ${mono}`}>
              <li>
                Qty: <span className="font-medium text-amber-800 dark:text-amber-200/90">{line.quantity.toLocaleString('en-IN')}</span>
              </li>
              <li>
                Planning UPS:{' '}
                <span className="font-medium text-amber-800 dark:text-amber-200/90">{pc.ups != null ? pc.ups : '—'}</span>
              </li>
              <li>
                Sheet / yield:{' '}
                <span className="text-slate-800 dark:text-slate-200">
                  {pc.actualSheetSizeLabel ?? '—'} ·{' '}
                  {pc.productionYieldPct != null ? `${pc.productionYieldPct}%` : '—'}
                </span>
              </li>
              <li>
                Mix-set:{' '}
                <span className="text-slate-800 dark:text-slate-200">
                  {pc.layoutType === 'gang' ? `Gang · ${pc.masterSetId ?? '—'}` : 'Single product'}
                </span>
              </li>
            </ul>
          </div>

          <div>
            <p className={`text-[10px] uppercase tracking-wide text-slate-500 ${mono}`}>Material Efficiency</p>
            <div className="mt-2 flex flex-col gap-3 rounded-lg border border-border bg-card/80 px-3 py-3 dark:border-slate-800 dark:bg-slate-950/40">
              {util && util.yieldPct > 0 ? (
                <div className="flex flex-col items-center">
                  <SemiGaugeUtilization pct={util.yieldPct} />
                  <p
                    className={`text-[10px] text-slate-600 dark:text-slate-400 mt-1 text-center leading-snug ${mono}`}
                  >
                    Utilization: {Math.round(util.yieldPct)}% | Off-cut Waste: {Math.round(100 - util.yieldPct)}%
                  </p>
                </div>
              ) : (
                <p className={`text-[10px] text-slate-500 ${mono}`}>
                  Enter blank size, parent sheet, and UPS on the row to show sheet utilization.
                </p>
              )}
              <div className="flex items-start justify-between gap-2 border-t border-[#E2E8F0] pt-2 dark:border-slate-800">
                <p className={`text-[11px] text-slate-700 dark:text-slate-300 leading-snug ${mono}`}>
                  Calculated Make-Ready Sheets:{' '}
                  <span className="font-semibold text-amber-800 dark:text-amber-200/90">{makeReady.totalSheets}</span>
                </p>
                <button
                  type="button"
                  className="inline-flex shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                  title={makeReady.detail}
                  aria-label={`Make-ready breakdown: ${makeReady.detail}`}
                >
                  <Info className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          </div>

          <div>
            <p className={`text-[10px] uppercase tracking-wide text-slate-500 mb-2 ${mono}`}>
              Hub sync (live)
            </p>
            <div className="flex flex-wrap justify-between gap-3">
              <RingPct label="AW" pct={awPct} tone={awTone} />
              <RingPct label="Plate" pct={platePct} tone={plTone} />
              <RingPct label="Die" pct={diePct} tone={diTone} />
              <RingPct label="Paper" pct={rmPct} tone={rmTone} />
            </div>
            <p className="text-[9px] text-slate-600 mt-2 leading-snug">
              Five-point strip: {five.allGreen && platesStatus === 'available' ? 'All green' : 'Blocked'}{' '}
              · Tooling: {ti.allReady ? 'OK' : 'Pending'}
            </p>
          </div>
        </div>
      </aside>
    </div>
  )
}
