'use client'

import { memo, useMemo } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { readPlanningMeta } from '@/lib/planning-decision-spec'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
}

type StepStatus = 'done' | 'active' | 'pending' | 'blocked'

type TraceStep = {
  id: string
  label: string
  status: StepStatus
  detail: string | null
  sub?: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dot(status: StepStatus): string {
  if (status === 'done') return 'bg-emerald-400'
  if (status === 'active') return 'bg-ds-brand animate-pulse'
  if (status === 'blocked') return 'bg-red-400'
  return 'bg-ds-line/60'
}

function labelClass(status: StepStatus): string {
  if (status === 'done') return 'text-ds-ink'
  if (status === 'active') return 'text-ds-brand'
  if (status === 'blocked') return 'text-red-300'
  return 'text-ds-ink-faint'
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}

const BALANCE_LABEL: Record<string, string> = {
  return_warehouse: 'Return to warehouse',
  add_existing: 'Add to existing stock',
  create_master: 'Create new master',
  reserve_another_job: 'Reserve for another job',
  scrap: 'Scrap',
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Visual chain showing the planning trace from PO → Board → Cut Plan →
 * Balance → Batch Lock. Each step carries a status dot so the planner
 * can see at a glance what's confirmed, what's in progress, and what's
 * still pending.
 */
export const SectionTraceabilityPreview = memo(function SectionTraceabilityPreview({
  line,
  readiness,
}: Props) {
  const spec = useMemo(
    () => (line.specOverrides ?? {}) as Record<string, unknown>,
    [line.specOverrides],
  )
  const meta = useMemo(() => readPlanningMeta(spec), [spec])

  // ── Derive step data ──────────────────────────────────────────────────────

  const po = line.po
  const poDetail = [po?.poNumber, po?.customer?.name].filter(Boolean).join(' · ') || null
  const poDate = formatDate(po?.poDate)

  const boardType = (line.paperType ?? readiness?.boardType ?? '').trim() || null
  const gsm = line.gsm ?? readiness?.gsm ?? null
  const boardLinked = !!(readiness?.materialId)
  const boardDetail = boardLinked
    ? [boardType, gsm != null ? `${gsm} GSM` : null, readiness?.size ?? null].filter(Boolean).join(' · ')
    : boardType
      ? [boardType, gsm != null ? `${gsm} GSM` : null].filter(Boolean).join(' · ')
      : null

  const rawChildren = meta.cutPlanChildSizes
  const hasCutPlan =
    Array.isArray(rawChildren) &&
    (rawChildren as Array<Record<string, unknown>>).some(
      (c) => Number(c.lMm) > 0 && Number(c.wMm) > 0 && Number(c.qty) > 0,
    )
  const totalQty = Array.isArray(rawChildren)
    ? (rawChildren as Array<Record<string, unknown>>).reduce(
        (a, c) => a + Math.floor(Number(c.qty ?? 0)),
        0,
      )
    : 0
  const cutDetail = hasCutPlan
    ? `${totalQty} pcs/sheet · ${meta.cuttingDirection === 'width' ? 'Width-wise' : 'Length-wise'}`
    : null

  const balanceAction = (meta.balanceAction as string | undefined) ?? null
  const balanceDetail = balanceAction ? (BALANCE_LABEL[balanceAction] ?? balanceAction) : null

  const prId = readiness?.prId ?? null
  const hasPr = !!prId
  const shortage = Number(readiness?.shortageSheets ?? 0)
  const stockOk = boardLinked && shortage === 0

  const batchStatus = line.batchDecision?.status ?? null
  const locked = !!line.batchDecision?.lockedAt
  const lockedAt = line.batchDecision?.lockedAt ?? null
  const lockedBy = line.batchDecision?.lockedByName ?? null

  // ── Build steps ───────────────────────────────────────────────────────────

  const steps: TraceStep[] = useMemo(() => {
    const s: TraceStep[] = []

    // 1. PO
    s.push({
      id: 'po',
      label: 'Purchase Order',
      status: 'done',
      detail: poDetail,
      sub: poDate || null,
    })

    // 2. Product / Carton
    s.push({
      id: 'product',
      label: 'Product',
      status: line.cartonName ? 'done' : 'pending',
      detail: [line.cartonName, line.cartonSize].filter(Boolean).join(' · ') || null,
      sub: line.artworkCode ? `AW: ${line.artworkCode}` : null,
    })

    // 3. Board selection
    const boardStatus: StepStatus = boardLinked
      ? stockOk
        ? 'done'
        : shortage > 0
          ? 'blocked'
          : 'done'
      : boardType
        ? 'active'
        : 'pending'
    s.push({
      id: 'board',
      label: 'Board Selection',
      status: boardStatus,
      detail: boardDetail,
      sub: boardLinked
        ? shortage > 0
          ? `Short ${Math.round(shortage)} sh`
          : hasPr
            ? `PR ${prId}`
            : 'Stock OK'
        : null,
    })

    // 4. Cut Plan
    const cutStatus: StepStatus = hasCutPlan ? 'done' : boardLinked ? 'active' : 'pending'
    s.push({
      id: 'cut',
      label: 'Cut Plan & Layout',
      status: cutStatus,
      detail: cutDetail,
      sub:
        hasCutPlan && typeof meta.makeReadySheets === 'number'
          ? `MR ${meta.makeReadySheets} sh`
          : null,
    })

    // 5. Balance
    const balanceStatus: StepStatus = balanceAction ? 'done' : hasCutPlan ? 'active' : 'pending'
    s.push({
      id: 'balance',
      label: 'Balance Stock',
      status: balanceStatus,
      detail: balanceDetail,
      sub: null,
    })

    // 6. Batch / Lock
    const batchSt: StepStatus = locked
      ? 'done'
      : batchStatus === 'Released' || batchStatus === 'ApprovedAW'
        ? 'done'
        : batchStatus === 'Hold'
          ? 'blocked'
          : batchStatus === 'Ready'
            ? 'active'
            : 'pending'
    s.push({
      id: 'batch',
      label: 'Batch Decision',
      status: batchSt,
      detail: locked
        ? `Locked${lockedBy ? ` · ${lockedBy}` : ''}`
        : batchStatus ?? null,
      sub: locked && lockedAt ? formatDate(lockedAt) : null,
    })

    return s
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    poDetail, poDate, boardLinked, boardDetail, stockOk, shortage, hasPr, prId,
    boardType, hasCutPlan, cutDetail, meta.makeReadySheets, balanceAction, balanceDetail,
    locked, batchStatus, lockedBy, lockedAt, line.cartonName, line.cartonSize, line.artworkCode,
  ])

  return (
    <CardSection title="TRACEABILITY">
      {/* Horizontal chain on md+, vertical stack on mobile */}
      <div className="flex flex-col md:flex-row md:items-start gap-0 md:gap-0 overflow-x-auto">
        {steps.map((step, idx) => (
          <div key={step.id} className="flex md:flex-col items-start md:items-center flex-1 min-w-0">
            {/* Step node */}
            <div className="flex md:flex-col items-center gap-2 md:gap-1.5 w-full">
              {/* Connector line — left of dot on md */}
              {idx > 0 ? (
                <div
                  className={[
                    'shrink-0',
                    'hidden md:block h-px flex-1 mt-[7px] self-start',
                    steps[idx - 1]!.status === 'done' ? 'bg-emerald-500/40' : 'bg-ds-line/30',
                  ].join(' ')}
                />
              ) : (
                <div className="hidden md:block flex-1" />
              )}

              {/* Dot */}
              <div
                className={`shrink-0 h-3.5 w-3.5 rounded-full border-2 border-ds-main ${dot(step.status)}`}
                aria-label={`${step.label}: ${step.status}`}
              />

              {/* Connector line — right of dot on md */}
              {idx < steps.length - 1 ? (
                <div
                  className={[
                    'shrink-0',
                    'hidden md:block h-px flex-1 mt-[7px] self-start',
                    step.status === 'done' ? 'bg-emerald-500/40' : 'bg-ds-line/30',
                  ].join(' ')}
                />
              ) : (
                <div className="hidden md:block flex-1" />
              )}

              {/* Mobile vertical connector */}
              {idx < steps.length - 1 ? (
                <div
                  className={[
                    'md:hidden w-px h-6 ml-[6px] -mt-1',
                    step.status === 'done' ? 'bg-emerald-500/40' : 'bg-ds-line/30',
                  ].join(' ')}
                />
              ) : null}
            </div>

            {/* Label + detail */}
            <div className="md:text-center px-1 pb-3 md:pb-0 min-w-0 w-full md:max-w-[100px]">
              <div className={`text-[11px] font-semibold leading-tight mt-1 ${labelClass(step.status)}`}>
                {step.label}
              </div>
              {step.detail ? (
                <div className="text-[10px] text-ds-ink-faint leading-snug mt-0.5 truncate">
                  {step.detail}
                </div>
              ) : null}
              {step.sub ? (
                <div className="text-[10px] text-ds-ink-faint/70 leading-snug">{step.sub}</div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </CardSection>
  )
})
