'use client'

import { X } from 'lucide-react'
import {
  computeFivePointReadiness,
  computeToolingInterlock,
  type MaterialGate,
  type MaterialGateStatus,
} from '@/lib/planning-interlock'
import { readPlanningCore } from '@/lib/planning-decision-spec'

const mono = 'font-designing-queue tabular-nums tracking-tight'

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
          <circle cx="24" cy="24" r={r} fill="none" className="stroke-zinc-800" strokeWidth="4" />
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
          className={`pointer-events-none absolute inset-0 flex items-center justify-center ${mono} text-[10px] font-semibold text-slate-200`}
        >
          {p}%
        </div>
      </div>
      <span className="text-[8px] uppercase tracking-wide text-slate-500 text-center leading-tight">
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
  } | null
  materialQueue?: { totalSheets: number } | null
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
}: {
  open: boolean
  line: DrawerLine | null
  onClose: () => void
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

  return (
    <div className="fixed inset-0 z-[90] flex justify-end">
      <button type="button" className="absolute inset-0 bg-black/75" aria-label="Close" onClick={onClose} />
      <aside className="relative h-full w-full max-w-md border-l border-slate-800 bg-[#000000] shadow-2xl flex flex-col">
        <div className="flex items-start justify-between gap-2 border-b border-slate-800 px-4 py-3">
          <div>
            <h2 className={`text-sm font-semibold text-amber-400 ${mono}`}>Readiness radar</h2>
            <p className="text-[10px] text-slate-500 mt-0.5 truncate max-w-[18rem]">{line.cartonName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:text-slate-200"
            aria-label="Close drawer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-4 overflow-y-auto flex-1">
          <div>
            <p className={`text-[10px] uppercase tracking-wide text-slate-500 ${mono}`}>Summary</p>
            <ul className={`mt-1 space-y-1 text-[11px] text-slate-300 ${mono}`}>
              <li>
                Qty: <span className="text-amber-200/90">{line.quantity.toLocaleString('en-IN')}</span>
              </li>
              <li>
                Planning UPS:{' '}
                <span className="text-amber-200/90">{pc.ups != null ? pc.ups : '—'}</span>
              </li>
              <li>
                Sheet / yield:{' '}
                <span className="text-slate-200">
                  {pc.actualSheetSizeLabel ?? '—'} ·{' '}
                  {pc.productionYieldPct != null ? `${pc.productionYieldPct}%` : '—'}
                </span>
              </li>
              <li>
                Mix-set:{' '}
                <span className="text-slate-200">
                  {pc.layoutType === 'gang' ? `Gang · ${pc.masterSetId ?? '—'}` : 'Single product'}
                </span>
              </li>
            </ul>
          </div>

          <div>
            <p className={`text-[10px] uppercase tracking-wide text-slate-500 mb-2 ${mono}`}>
              Hub sync (live)
            </p>
            <div className="flex flex-wrap justify-between gap-3">
              <RingPct label="AW" pct={awPct} tone={awTone} />
              <RingPct label="Plate" pct={platePct} tone={plTone} />
              <RingPct label="Die" pct={diePct} tone={diTone} />
              <RingPct label="RM" pct={rmPct} tone={rmTone} />
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
