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
          ? 'border-emerald-500/70 bg-emerald-500/20 text-emerald-300'
          : grey
            ? 'border-ds-line/60 bg-ds-elevated text-ds-ink-muted'
            : 'border-rose-500/70 bg-rose-500/20 text-rose-300'
        return (
          <span
            key={s.key}
            title={s.title}
            className={`inline-flex h-6 min-w-[32px] items-center justify-center rounded-md border text-[11px] font-bold leading-none font-designing-queue ${stateClass}`}
          >
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
    p >= 85 ? 'stroke-emerald-500' : p >= 60 ? 'stroke-ds-warning' : 'stroke-rose-500'
  return (
    <div className="flex flex-col items-center gap-1" aria-hidden>
      <svg viewBox="0 0 48 28" className="h-16 w-28">
        <path
          d="M 6 24 A 18 18 0 0 1 42 24"
          fill="none"
          className="stroke-neutral-200 dark:stroke-ds-elevated"
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
      <span className={`${mono} text-[11px] font-semibold text-ds-ink`}>{p}%</span>
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
        ? 'stroke-ds-warning'
        : tone === 'rose'
          ? 'stroke-rose-500'
          : 'stroke-neutral-500'
  return (
    <div className="flex flex-col items-center gap-1 min-w-[4.5rem]">
      <div className="relative h-14 w-14" aria-hidden>
        <svg viewBox="0 0 48 48" className="h-full w-full -rotate-90">
          <circle cx="24" cy="24" r={r} fill="none" className="stroke-neutral-200 dark:stroke-ds-elevated" strokeWidth="4" />
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
          className={`pointer-events-none absolute inset-0 flex items-center justify-center ${mono} text-[10px] font-semibold text-ds-ink`}
        >
          {p}%
        </div>
      </div>
      <span className="text-[8px] uppercase tracking-wide text-ds-ink-faint text-center leading-tight">
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
  artworkCode?: string | null
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
  po?: { poNumber: string; poDate?: string; customer: { name: string } }
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
  const platePct = platesStatus === 'available' ? 100 : platesStatus === 'partial' ? 50 : 0
  const diePct = dieStatus === 'good' ? 100 : dieStatus === 'attention' ? 45 : 0
  const rmPct =
    mg.status === 'available' ? 100 : mg.status === 'ordered' ? 55 : mg.status === 'shortage' ? 0 : 25

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
  const materialUtilPct = util?.yieldPct ?? 0
  const productionReadinessPct = Math.round((awPct + platePct + diePct + rmPct) / 4)
  const materialTone = materialUtilPct >= 85 ? 'emerald' : materialUtilPct >= 60 ? 'amber' : 'rose'
  const readinessTone = productionReadinessPct >= 85 ? 'emerald' : productionReadinessPct >= 60 ? 'amber' : 'rose'

  return (
    <div className="fixed inset-0 z-[90] flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-black/55 backdrop-blur-[1px]"
        aria-label="Close"
        onClick={onClose}
      />
      <aside
        className="relative flex h-full w-full max-w-[450px] flex-col border-l border-ds-line/50 bg-ds-main shadow-[-10px_0_30px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-start justify-between gap-2 border-b border-ds-line/40 bg-black/40 px-4 py-3">
          <div className="min-w-0">
            <p className="font-id-mono text-xs text-ds-warning truncate">
              PO {line.po?.poNumber ?? '—'}
            </p>
            <h2 className="text-sm font-semibold text-ds-ink truncate pr-2">{line.cartonName}</h2>
            <p className="text-[10px] text-ds-ink-faint mt-0.5 truncate max-w-[18rem]">
              {line.po?.customer?.name ?? '—'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ds-ink-muted hover:bg-ds-elevated hover:text-ds-ink"
            aria-label="Close drawer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          <div className="rounded-lg border border-ds-line/40 bg-ds-card/60 p-3">
            <p className={`text-[10px] uppercase tracking-wide text-ds-ink-faint ${mono}`}>I. Product DNA</p>
            <div className="mt-2 space-y-1 text-[13px] text-ds-ink">
              <p className="truncate">
                <span className="font-medium text-ds-ink-faint">Carton:</span> {line.cartonName ?? '—'}
              </p>
              <p>
                <span className="font-medium text-ds-ink-faint">PO Date:</span> {line.po?.poDate ?? '—'}
              </p>
              <p className={`${mono}`}>
                <span className="font-medium text-ds-ink-faint font-sans">Artwork:</span>{' '}
                {line.artworkCode?.trim() || String(spec.artworkCode ?? '—')}
              </p>
            </div>
          </div>

          <div>
            <p className={`text-[10px] uppercase tracking-wide text-ds-ink-faint ${mono}`}>Readiness ledger</p>
            <div className="mt-2">
              <FiveStrip segments={five.segments} />
            </div>
          </div>

          <div>
            <p className={`text-[10px] uppercase tracking-wide text-ds-ink-faint ${mono}`}>Quick assign designer</p>
            <select
              value={pc.designerKey ?? ''}
              onChange={(e) => {
                const v = e.target.value
                const key =
                  v === 'avneet_singh' || v === 'shamsher_inder' ? (v as PlanningDesignerKey) : ''
                onDesignerKeyChange?.(line.id, key)
              }}
              className={`mt-1 w-full h-9 rounded border border-ds-line/50 bg-ds-main px-2 text-xs text-ds-ink ${mono}`}
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
            <p className={`text-[10px] uppercase tracking-wide text-ds-ink-faint ${mono}`}>Summary</p>
            <ul className={`mt-1 space-y-1 text-[11px] text-ds-ink-muted ${mono}`}>
              <li>
                Qty: <span className="font-medium text-ds-warning">{line.quantity.toLocaleString('en-IN')}</span>
              </li>
              <li>
                Planning UPS:{' '}
                <span className="font-medium text-ds-warning">{pc.ups != null ? pc.ups : '—'}</span>
              </li>
              <li>
                Sheet / yield:{' '}
                <span className="text-ds-ink">
                  {pc.actualSheetSizeLabel ?? '—'} ·{' '}
                  {pc.productionYieldPct != null ? `${pc.productionYieldPct}%` : '—'}
                </span>
              </li>
              <li>
                Mix-set:{' '}
                <span className="text-ds-ink">
                  {pc.layoutType === 'gang' ? `Gang · ${pc.masterSetId ?? '—'}` : 'Single product'}
                </span>
              </li>
            </ul>
          </div>

          <div>
            <p className={`text-[10px] uppercase tracking-wide text-ds-ink-faint ${mono}`}>Material Efficiency</p>
            <div className="mt-2 flex flex-col gap-3 rounded-lg border border-ds-line/40 bg-ds-card/60 px-3 py-3">
              {util && util.yieldPct > 0 ? (
                <div className="flex flex-col items-center">
                  <SemiGaugeUtilization pct={util.yieldPct} />
                  <p
                    className={`text-[10px] text-ds-ink-muted mt-1 text-center leading-snug ${mono}`}
                  >
                    Utilization: {Math.round(util.yieldPct)}% | Off-cut Waste: {Math.round(100 - util.yieldPct)}%
                  </p>
                </div>
              ) : (
                <p className={`text-[10px] text-ds-ink-faint ${mono}`}>
                  Enter blank size, parent sheet, and UPS on the row to show sheet utilization.
                </p>
              )}
              <div className="flex items-start justify-between gap-2 border-t border-ds-line/40 pt-2">
                <p className={`text-[11px] text-ds-ink-muted leading-snug ${mono}`}>
                  Calculated Make-Ready Sheets:{' '}
                  <span className="font-semibold text-ds-warning">{makeReady.totalSheets}</span>
                </p>
                <button
                  type="button"
                  className="inline-flex shrink-0 rounded p-0.5 text-ds-ink-muted hover:bg-ds-elevated hover:text-ds-ink"
                  title={makeReady.detail}
                  aria-label={`Make-ready breakdown: ${makeReady.detail}`}
                >
                  <Info className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-ds-line/40 bg-ds-card/60 p-3">
            <p className={`mb-2 text-[10px] uppercase tracking-wide text-ds-ink-faint ${mono}`}>
              II. Efficiency Gauges
            </p>
            <div className="flex items-start justify-between gap-3">
              <RingPct label="Material Utilization" pct={materialUtilPct} tone={materialTone} />
              <RingPct label="Production Readiness" pct={productionReadinessPct} tone={readinessTone} />
            </div>
            <p className="mt-2 text-[9px] leading-snug text-ds-ink-muted">
              Five-point strip: {five.allGreen && platesStatus === 'available' ? 'All green' : 'Blocked'} · Tooling:{' '}
              {ti.allReady ? 'OK' : 'Pending'}
            </p>
          </div>
        </div>
      </aside>
    </div>
  )
}
