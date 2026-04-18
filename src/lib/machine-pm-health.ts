import { Prisma, type PrismaClient } from '@prisma/client'

export const PREVENTIVE_MAINTENANCE_AUDIT_MESSAGE =
  'Preventive Maintenance Verified - Machine Health Reset to 100%.'

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10))
}

export function computePmHealthPct(params: {
  usageRunHours: number
  usageImpressions: bigint | number
  intervalRunHours: number | null
  intervalImpressions: bigint | number | null
}): {
  healthPct: number
  hourHealth: number | null
  impressionHealth: number | null
} {
  const uH = params.usageRunHours
  const uImp =
    typeof params.usageImpressions === 'bigint' ? Number(params.usageImpressions) : params.usageImpressions

  let hourHealth: number | null = null
  if (params.intervalRunHours != null && params.intervalRunHours > 0) {
    hourHealth = (1 - uH / params.intervalRunHours) * 100
  }

  let impressionHealth: number | null = null
  if (params.intervalImpressions != null) {
    const intImp =
      typeof params.intervalImpressions === 'bigint'
        ? Number(params.intervalImpressions)
        : params.intervalImpressions
    if (intImp > 0) impressionHealth = (1 - uImp / intImp) * 100
  }

  const parts = [hourHealth, impressionHealth].filter((x): x is number => x != null && Number.isFinite(x))
  const raw = parts.length === 0 ? 100 : Math.min(...parts)
  return {
    healthPct: clampPct(raw),
    hourHealth: hourHealth != null ? clampPct(hourHealth) : null,
    impressionHealth: impressionHealth != null ? clampPct(impressionHealth) : null,
  }
}

export type MachinePmHealthRow = {
  machineId: string
  machineCode: string
  name: string
  healthPct: number
  hourHealth: number | null
  impressionHealth: number | null
  usageRunHours: number
  usageImpressions: string
  intervalRunHours: number | null
  intervalImpressions: string | null
  overdue: boolean
  hasSchedule: boolean
}

export function numFromDecimal(d: Prisma.Decimal): number {
  return Number(d)
}

export function toMachinePmHealthRow(
  m: {
    id: string
    machineCode: string
    name: string
    usageRunHoursSincePm: Prisma.Decimal
    usageImpressionsSincePm: bigint
    pmSchedule: {
      intervalRunHours: Prisma.Decimal
      intervalImpressions: bigint
    } | null
  },
): MachinePmHealthRow {
  const schedule = m.pmSchedule
  const intervalH = schedule ? numFromDecimal(schedule.intervalRunHours) : null
  const intervalImp = schedule?.intervalImpressions ?? null
  const usageH = numFromDecimal(m.usageRunHoursSincePm)
  const usageImp = m.usageImpressionsSincePm

  const { healthPct, hourHealth, impressionHealth } = computePmHealthPct({
    usageRunHours: usageH,
    usageImpressions: usageImp,
    intervalRunHours: intervalH,
    intervalImpressions: intervalImp,
  })

  return {
    machineId: m.id,
    machineCode: m.machineCode,
    name: m.name,
    healthPct,
    hourHealth,
    impressionHealth,
    usageRunHours: Math.round(usageH * 100) / 100,
    usageImpressions: usageImp.toString(),
    intervalRunHours: intervalH,
    intervalImpressions: intervalImp != null ? intervalImp.toString() : null,
    overdue: schedule != null && healthPct < 50,
    hasSchedule: schedule != null,
  }
}

export async function loadMachinePmHealthMap(
  db: Pick<PrismaClient, 'machine'>,
  machineIds: string[],
): Promise<Map<string, MachinePmHealthRow>> {
  const uniq = Array.from(new Set(machineIds.filter(Boolean)))
  const map = new Map<string, MachinePmHealthRow>()
  if (uniq.length === 0) return map

  const rows = await db.machine.findMany({
    where: { id: { in: uniq } },
    select: {
      id: true,
      machineCode: true,
      name: true,
      usageRunHoursSincePm: true,
      usageImpressionsSincePm: true,
      pmSchedule: {
        select: { intervalRunHours: true, intervalImpressions: true },
      },
    },
  })
  for (const m of rows) {
    map.set(m.id, toMachinePmHealthRow(m))
  }
  return map
}

/** Monday 00:00:00.000 to next Monday 00:00:00.000 in local time. */
export function getLocalCalendarWeekRange(ref: Date): { weekStart: Date; weekEnd: Date } {
  const d = new Date(ref)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  const weekStart = new Date(d)
  weekStart.setDate(d.getDate() + mondayOffset)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 7)
  return { weekStart, weekEnd }
}

function overlapHours(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const start = new Date(Math.max(aStart.getTime(), bStart.getTime()))
  const end = new Date(Math.min(aEnd.getTime(), bEnd.getTime()))
  const ms = end.getTime() - start.getTime()
  return ms > 0 ? ms / 3_600_000 : 0
}

export async function sumScheduledPmHoursThisWeek(
  db: Pick<PrismaClient, 'pmPlannedDowntime'>,
  ref: Date = new Date(),
): Promise<number> {
  const { weekStart, weekEnd } = getLocalCalendarWeekRange(ref)
  const slots = await db.pmPlannedDowntime.findMany({
    where: {
      plannedEnd: { gt: weekStart },
      plannedStart: { lt: weekEnd },
    },
    select: { plannedStart: true, plannedEnd: true },
  })
  let hours = 0
  for (const s of slots) {
    hours += overlapHours(s.plannedStart, s.plannedEnd, weekStart, weekEnd)
  }
  return Math.round(hours * 100) / 100
}

export type MachinePmKpis = {
  factoryHealthAvg: number | null
  pmOverdueCount: number
  scheduledPmHoursThisWeek: number
  machines: MachinePmHealthRow[]
}

export async function getMachinePmKpiBundle(db: PrismaClient, ref: Date = new Date()): Promise<MachinePmKpis> {
  const machines = await db.machine.findMany({
    orderBy: { machineCode: 'asc' },
    select: {
      id: true,
      machineCode: true,
      name: true,
      usageRunHoursSincePm: true,
      usageImpressionsSincePm: true,
      pmSchedule: {
        select: { intervalRunHours: true, intervalImpressions: true },
      },
    },
  })

  const rows = machines.map(toMachinePmHealthRow)
  const scheduled = await sumScheduledPmHoursThisWeek(db, ref)

  const scheduledRows = rows.filter((r) => r.hasSchedule)
  const factoryHealthAvg =
    scheduledRows.length > 0
      ? clampPct(scheduledRows.reduce((s, r) => s + r.healthPct, 0) / scheduledRows.length)
      : null
  const pmOverdueCount = rows.filter((r) => r.overdue).length

  return {
    factoryHealthAvg,
    pmOverdueCount,
    scheduledPmHoursThisWeek: scheduled,
    machines: rows,
  }
}

export async function incrementMachineUsageSinceLastPm(
  db: Pick<PrismaClient, 'machine'>,
  machineId: string,
  runHours: number,
  impressions: number,
): Promise<void> {
  const rh = Math.max(0, runHours)
  const imp = Math.max(0, Math.floor(impressions))
  if (rh <= 0 && imp <= 0) return

  await db.machine.update({
    where: { id: machineId },
    data: {
      ...(rh > 0 && {
        usageRunHoursSincePm: { increment: new Prisma.Decimal(rh) },
      }),
      ...(imp > 0 && {
        usageImpressionsSincePm: { increment: BigInt(imp) },
      }),
    },
  })
}

export async function completePreventiveMaintenanceSignOff(
  db: PrismaClient,
  params: { machineId: string; verifiedByUserId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const machine = await db.machine.findUnique({
    where: { id: params.machineId },
    select: {
      id: true,
      usageRunHoursSincePm: true,
      usageImpressionsSincePm: true,
      pmSchedule: { select: { id: true } },
    },
  })
  if (!machine) return { ok: false, error: 'Machine not found' }
  if (!machine.pmSchedule) return { ok: false, error: 'No PM schedule configured for this machine' }

  const runH = numFromDecimal(machine.usageRunHoursSincePm)
  const imp = machine.usageImpressionsSincePm

  await db.$transaction([
    db.preventiveMaintenanceLog.create({
      data: {
        machineId: machine.id,
        verifiedAt: new Date(),
        verifiedByUserId: params.verifiedByUserId,
        signedOffNote: PREVENTIVE_MAINTENANCE_AUDIT_MESSAGE,
        runHoursBeforeReset: machine.usageRunHoursSincePm,
        impressionsBeforeReset: imp,
      },
    }),
    db.machine.update({
      where: { id: machine.id },
      data: {
        usageRunHoursSincePm: new Prisma.Decimal(0),
        usageImpressionsSincePm: BigInt(0),
        lastPmDate: new Date(),
      },
    }),
  ])

  return { ok: true }
}
