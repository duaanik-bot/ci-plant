import { Prisma, type PrismaClient } from '@prisma/client'
import { incrementMachineUsageSinceLastPm } from '@/lib/machine-pm-health'
import { computeJobYieldMetricsForCard } from '@/lib/production-yield'
import {
  PRODUCTION_DOWNTIME_LOCK_SECONDS,
  PRODUCTION_SHIFT_MINUTES_DEFAULT,
} from '@/lib/production-oee-constants'

export {
  PRODUCTION_DOWNTIME_LOCK_SECONDS,
  PRODUCTION_SHIFT_MINUTES_DEFAULT,
  PRODUCTION_DOWNTIME_CATEGORIES,
} from '@/lib/production-oee-constants'
export type { ProductionDowntimeCategoryKey } from '@/lib/production-oee-constants'

const PLANNED_STOP_KEYS = new Set<string>(['CHANGEOVER_SETUP'])

export function isUnplannedDowntimeCategory(key: string): boolean {
  return !PLANNED_STOP_KEYS.has(key)
}

export function ratedSheetsPerHour(capacityPerShift: number, shiftHours = 8): number {
  if (!Number.isFinite(capacityPerShift) || capacityPerShift <= 0) return 0
  return capacityPerShift / shiftHours
}

export function secondsSinceLastProductionPulse(params: {
  status: string
  lastProductionTickAt: Date | null
  inProgressSince: Date | null
  createdAt: Date
}): number | null {
  if (params.status !== 'in_progress') return null
  const ref = params.lastProductionTickAt ?? params.inProgressSince ?? params.createdAt
  return Math.max(0, Math.floor((Date.now() - ref.getTime()) / 1000))
}

export function downtimeLockActive(secondsIdle: number | null): boolean {
  return secondsIdle != null && secondsIdle > PRODUCTION_DOWNTIME_LOCK_SECONDS
}

/** Instantaneous run rate (sheets/h); zero if idle beyond lock window. */
export function currentSpeedPph(params: {
  counter: number | null
  inProgressSince: Date | null
  lastProductionTickAt: Date | null
}): number {
  const c = params.counter
  if (c == null || c <= 0 || !params.inProgressSince) return 0
  const tick = params.lastProductionTickAt ?? params.inProgressSince
  const idleSec = (Date.now() - tick.getTime()) / 1000
  if (idleSec > PRODUCTION_DOWNTIME_LOCK_SECONDS) return 0
  const hours = Math.max(1 / 60, (Date.now() - params.inProgressSince.getTime()) / 3_600_000)
  return Math.round((c / hours) * 10) / 10
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function sumDowntimeMinutesForJob(db: PrismaClient, productionJobCardId: string): Promise<number> {
  const agg = await db.productionDowntimeLog.aggregate({
    where: {
      productionJobCardId,
      durationSeconds: { not: null },
    },
    _sum: { durationSeconds: true },
  })
  return (agg._sum.durationSeconds ?? 0) / 60
}

export type LiveOeeBundle = {
  oee: number
  availability: number
  performance: number
  quality: number
  currentSpeedPph: number
  ratedSpeedPph: number
  secondsSinceLastTick: number | null
  downtimeLock: boolean
}

export async function computeLiveOeeForJobCard(
  db: PrismaClient,
  job: {
    id: string
    createdAt: Date
    totalSheets: number
    wastageSheets: number
    status: string
    machineId: string | null
    machine: { capacityPerShift: number } | null
  },
  stage: {
    status: string
    counter: number | null
    lastProductionTickAt: Date | null
    inProgressSince: Date | null
    createdAt: Date
  },
): Promise<LiveOeeBundle | null> {
  if (stage.status !== 'in_progress') return null

  const machine =
    job.machine ??
    (await db.machine.findFirst({
      where: { status: 'active' },
      orderBy: { machineCode: 'asc' },
    }))

  const ratedSpeedPph = machine ? ratedSheetsPerHour(machine.capacityPerShift) : 1000

  const shiftMinutes = Math.min(
    PRODUCTION_SHIFT_MINUTES_DEFAULT,
    Math.max(
      15,
      Math.round((Date.now() - job.createdAt.getTime()) / 60_000),
    ),
  )

  const downtimeMin = await sumDowntimeMinutesForJob(db, job.id)
  const runMinutes = Math.max(1, Math.round(shiftMinutes - downtimeMin))
  const availability = shiftMinutes > 0 ? clampPct((runMinutes / shiftMinutes) * 100) : 0

  const speed = currentSpeedPph({
    counter: stage.counter,
    inProgressSince: stage.inProgressSince,
    lastProductionTickAt: stage.lastProductionTickAt,
  })
  const performance =
    ratedSpeedPph > 0 ? clampPct((speed / ratedSpeedPph) * 100) : 0

  const total = Math.max(1, job.totalSheets)
  const good = Math.max(0, Math.min(total, job.totalSheets - job.wastageSheets))
  const quality = clampPct((good / total) * 100)

  const oee = round2((availability * performance * quality) / 10_000)

  const secIdle = secondsSinceLastProductionPulse({
    status: stage.status,
    lastProductionTickAt: stage.lastProductionTickAt,
    inProgressSince: stage.inProgressSince,
    createdAt: stage.createdAt,
  })

  return {
    oee,
    availability,
    performance,
    quality,
    currentSpeedPph: speed,
    ratedSpeedPph,
    secondsSinceLastTick: secIdle,
    downtimeLock: downtimeLockActive(secIdle),
  }
}

export async function persistProductionOeeLedger(db: PrismaClient, productionJobCardId: string) {
  const existing = await db.productionOeeLedger.findUnique({
    where: { productionJobCardId },
  })
  if (existing) return existing

  const jc = await db.productionJobCard.findUnique({
    where: { id: productionJobCardId },
    include: {
      stages: true,
      machine: true,
    },
  })
  if (!jc) return null

  const machine =
    jc.machine ??
    (await db.machine.findFirst({
      where: { status: 'active' },
      orderBy: { machineCode: 'asc' },
    }))

  const ratedSpeedPph = machine ? ratedSheetsPerHour(machine.capacityPerShift) : 1000

  const shiftMinutes = Math.min(
    24 * 60,
    Math.max(30, Math.round((Date.now() - jc.createdAt.getTime()) / 60_000)),
  )
  const downtimeMin = await sumDowntimeMinutesForJob(db, jc.id)
  const runMinutes = Math.max(1, Math.round(shiftMinutes - downtimeMin))

  const availability = clampPct((runMinutes / shiftMinutes) * 100)

  const pasting = jc.stages.find((s) => s.stageName === 'Pasting')
  const counters = jc.stages.map((s) => s.counter).filter((c): c is number => c != null && c > 0)
  const maxCounter = counters.length ? Math.max(...counters) : 0
  const totalPieces = Math.max(maxCounter, pasting?.counter ?? 0, jc.totalSheets, 1)
  const goodPieces = Math.max(0, Math.min(totalPieces, jc.totalSheets - jc.wastageSheets))

  const runHours = runMinutes / 60
  const actualAvgSpeedPph = runHours > 0 ? totalPieces / runHours : 0
  const performance =
    ratedSpeedPph > 0 ? clampPct((actualAvgSpeedPph / ratedSpeedPph) * 100) : 0

  const quality =
    jc.totalSheets > 0 ? clampPct((goodPieces / jc.totalSheets) * 100) : clampPct(100)

  const oee = round2((availability * performance * quality) / 10_000)

  const poLine =
    jc.jobCardNumber != null
      ? await db.poLineItem.findFirst({
          where: { jobCardNumber: jc.jobCardNumber },
          select: {
            directorPriority: true,
            gsm: true,
            dimLengthMm: true,
            dimWidthMm: true,
            po: { select: { isPriority: true } },
            carton: {
              select: {
                finishedLength: true,
                finishedWidth: true,
                blankLength: true,
                blankWidth: true,
                gsm: true,
              },
            },
          },
        })
      : null

  const yieldMetrics = await computeJobYieldMetricsForCard(db, jc, poLine)
  const yieldPct = yieldMetrics.yieldPercent
  const industrialPriority = !!(poLine?.directorPriority || poLine?.po.isPriority)
  const incentiveEligible =
    industrialPriority &&
    yieldPct != null &&
    yieldPct > 96 &&
    oee > 85

  return db.$transaction(async (tx) => {
    const ledger = await tx.productionOeeLedger.create({
      data: {
        productionJobCardId: jc.id,
        machineId: machine?.id ?? null,
        availabilityPct: new Prisma.Decimal(availability),
        performancePct: new Prisma.Decimal(performance),
        qualityPct: new Prisma.Decimal(quality),
        oeePct: new Prisma.Decimal(oee),
        shiftMinutes,
        runMinutes,
        ratedSpeedPph: new Prisma.Decimal(round2(ratedSpeedPph)),
        actualAvgSpeedPph: new Prisma.Decimal(round2(actualAvgSpeedPph)),
        goodPieces,
        totalPieces,
        yieldPercent: yieldPct != null ? new Prisma.Decimal(round2(yieldPct)) : null,
        incentiveEligible,
        attributedOperatorUserId: jc.shiftOperatorUserId ?? null,
      },
    })

    const mid = machine?.id
    if (mid) {
      const runHours = runMinutes / 60
      await incrementMachineUsageSinceLastPm(tx, mid, runHours, totalPieces)
    }

    return ledger
  })
}

export function oeeBandClass(oee: number): 'emerald' | 'amber' | 'rose' {
  if (oee >= 85) return 'emerald'
  if (oee >= 60) return 'amber'
  return 'rose'
}

export function oeeCellClass(oee: number): string {
  const b = oeeBandClass(oee)
  if (b === 'emerald') return 'text-emerald-500'
  if (b === 'amber') return 'text-ds-warning'
  return 'text-rose-500'
}
