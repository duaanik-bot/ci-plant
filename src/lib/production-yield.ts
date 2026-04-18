import type { Prisma, PrismaClient } from '@prisma/client'

type DbForPaperShortClose = Pick<PrismaClient, 'paperIssueToFloor' | 'paperWarehouse'>
import { estimateKgForSheets, resolveKgPerSheetForPaper } from '@/lib/paper-interconnect'

/** ISO A0-ish CI sheet fallback when MRP cannot resolve kg/sheet (560×670 mm). */
export const DEFAULT_PRESS_SHEET_AREA_M2 = 0.56 * 0.67

export const YIELD_FINAL_AUDIT_MESSAGE =
  'Yield Verified by Production Manager - Final Audit by Anik Dua.'

export const RECYCLE_SCRAP_LOCATION = 'RECYCLE_SCRAP'

export type JobYieldMetrics = {
  yieldPercent: number | null
  theoreticalWeightKg: number | null
  actualIssuedWeightKg: number | null
  finishedGoodsCount: number
  totalSheetsIssuedFloor: number
  plannedWastePercent: number
  unexplainedWastePercent: number
  wastageVariancePercent: number | null
}

export function theoreticalCartonWeightKg(
  lengthMm: number,
  widthMm: number,
  gsm: number,
): number | null {
  if (!Number.isFinite(lengthMm) || !Number.isFinite(widthMm) || !Number.isFinite(gsm)) return null
  if (lengthMm <= 0 || widthMm <= 0 || gsm <= 0) return null
  const areaM2 = (lengthMm / 1000) * (widthMm / 1000)
  const kg = (areaM2 * gsm) / 1000
  return Math.round(kg * 1_000_000) / 1_000_000
}

function fallbackKgPerSheetFromGsm(gsm: number): number {
  return (DEFAULT_PRESS_SHEET_AREA_M2 * gsm) / 1000
}

export function finishedGoodsFromStages(
  stages: Array<{ stageName: string; counter: number | null; status: string }>,
): number {
  const pasting = stages.find((s) => s.stageName === 'Pasting')
  if (pasting?.counter != null && pasting.counter > 0) return pasting.counter
  const counters = stages
    .map((s) => s.counter)
    .filter((c): c is number => c != null && c > 0)
  if (counters.length === 0) return 0
  return Math.max(...counters)
}

function pickCartonMmAndGsm(
  carton:
    | {
        finishedLength: Prisma.Decimal | null
        finishedWidth: Prisma.Decimal | null
        blankLength: Prisma.Decimal | null
        blankWidth: Prisma.Decimal | null
        gsm: number | null
      }
    | null
    | undefined,
  poLine: { gsm: number | null; dimLengthMm: Prisma.Decimal | null; dimWidthMm: Prisma.Decimal | null },
): { L: number; W: number; gsm: number } | null {
  const g = carton?.gsm ?? poLine.gsm
  if (g == null || g <= 0) return null
  const fl = carton?.finishedLength != null ? Number(carton.finishedLength) : null
  const fw = carton?.finishedWidth != null ? Number(carton.finishedWidth) : null
  if (fl != null && fw != null && fl > 0 && fw > 0) return { L: fl, W: fw, gsm: g }
  const bl = carton?.blankLength != null ? Number(carton.blankLength) : null
  const bw = carton?.blankWidth != null ? Number(carton.blankWidth) : null
  if (bl != null && bw != null && bl > 0 && bw > 0) return { L: bl, W: bw, gsm: g }
  const dl = poLine.dimLengthMm != null ? Number(poLine.dimLengthMm) : null
  const dw = poLine.dimWidthMm != null ? Number(poLine.dimWidthMm) : null
  if (dl != null && dw != null && dl > 0 && dw > 0) return { L: dl, W: dw, gsm: g }
  return null
}

export function buildJobYieldMetrics(input: {
  finishedGoodsCount: number
  totalSheetsIssuedFloor: number
  wastageSheets: number
  totalSheets: number
  theoreticalUnitKg: number | null
  actualIssuedKg: number | null
}): JobYieldMetrics {
  const { finishedGoodsCount, totalSheetsIssuedFloor, wastageSheets, totalSheets, theoreticalUnitKg, actualIssuedKg } =
    input
  const theoreticalWeightKg =
    theoreticalUnitKg != null && finishedGoodsCount > 0
      ? Math.round(theoreticalUnitKg * finishedGoodsCount * 1000) / 1000
      : null

  const yieldPercent =
    theoreticalWeightKg != null &&
    actualIssuedKg != null &&
    actualIssuedKg > 0 &&
    theoreticalWeightKg > 0
      ? Math.round((theoreticalWeightKg / actualIssuedKg) * 10_000) / 100
      : null

  const plannedWastePercent =
    totalSheets > 0 ? Math.round((wastageSheets / totalSheets) * 1000) / 10 : 0

  const unexplainedWastePercent =
    yieldPercent != null
      ? Math.max(0, Math.round((100 - plannedWastePercent - yieldPercent) * 10) / 10)
      : 0

  const wastageVariancePercent =
    yieldPercent != null && yieldPercent < 100 ? Math.round((100 - yieldPercent) * 10) / 10 : null

  return {
    yieldPercent,
    theoreticalWeightKg,
    actualIssuedWeightKg: actualIssuedKg,
    finishedGoodsCount,
    totalSheetsIssuedFloor,
    plannedWastePercent,
    unexplainedWastePercent,
    wastageVariancePercent,
  }
}

export async function resolveActualIssuedKgForJob(
  db: PrismaClient,
  jobCardId: string,
): Promise<{ kg: number | null; totalSheets: number }> {
  const issues = await db.paperIssueToFloor.findMany({
    where: { productionJobCardId: jobCardId },
    include: {
      source: {
        select: {
          id: true,
          gsm: true,
          boardGrade: true,
          paperType: true,
          rate: true,
        },
      },
    },
  })
  if (issues.length === 0) return { kg: null, totalSheets: 0 }
  const kgBySource = new Map<string, number | null>()
  for (const iss of issues) {
    const sid = iss.sourcePaperWarehouseId
    if (!kgBySource.has(sid)) {
      const resolved = await resolveKgPerSheetForPaper(db, iss.source)
      kgBySource.set(sid, resolved ?? fallbackKgPerSheetFromGsm(iss.source.gsm))
    }
  }
  let sumKg = 0
  let hasAny = false
  let totalSheets = 0
  for (const iss of issues) {
    const kps = kgBySource.get(iss.sourcePaperWarehouseId)
    const kg = estimateKgForSheets(iss.qtySheets, kps ?? null)
    totalSheets += iss.qtySheets
    if (kg != null) {
      sumKg += kg
      hasAny = true
    }
  }
  return { kg: hasAny ? Math.round(sumKg * 1000) / 1000 : null, totalSheets }
}

export async function computeJobYieldMetricsForCard(
  db: PrismaClient,
  job: {
    id: string
    wastageSheets: number
    totalSheets: number
    stages: Array<{ stageName: string; counter: number | null; status: string }>
  },
  poLine: {
    gsm: number | null
    dimLengthMm: Prisma.Decimal | null
    dimWidthMm: Prisma.Decimal | null
    carton: {
      finishedLength: Prisma.Decimal | null
      finishedWidth: Prisma.Decimal | null
      blankLength: Prisma.Decimal | null
      blankWidth: Prisma.Decimal | null
      gsm: number | null
    } | null
  } | null,
): Promise<JobYieldMetrics> {
  const dims = poLine ? pickCartonMmAndGsm(poLine.carton, poLine) : null
  const theoreticalUnitKg = dims ? theoreticalCartonWeightKg(dims.L, dims.W, dims.gsm) : null
  const fg = finishedGoodsFromStages(job.stages)
  const { kg: actualIssuedKg, totalSheets: totalSheetsIssuedFloor } = await resolveActualIssuedKgForJob(db, job.id)
  return buildJobYieldMetrics({
    finishedGoodsCount: fg,
    totalSheetsIssuedFloor,
    wastageSheets: job.wastageSheets,
    totalSheets: job.totalSheets,
    theoreticalUnitKg,
    actualIssuedKg,
  })
}

/** Move floor stock issued to this job into recycle/scrap location (short-close). */
export async function shortCloseFloorStockForJob(dbx: DbForPaperShortClose, productionJobCardId: string) {
  const issues = await dbx.paperIssueToFloor.findMany({
    where: {
      productionJobCardId,
      destinationWarehouseId: { not: null },
    },
    select: { destinationWarehouseId: true },
  })
  const destIds = Array.from(
    new Set(issues.map((i) => i.destinationWarehouseId).filter(Boolean)),
  ) as string[]
  if (destIds.length === 0) return { movedBatchIds: [] as string[] }
  await dbx.paperWarehouse.updateMany({
    where: { id: { in: destIds } },
    data: { location: RECYCLE_SCRAP_LOCATION },
  })
  return { movedBatchIds: destIds }
}

export async function computeYieldSummaryForDashboard(db: PrismaClient): Promise<{
  netYieldPercent: number | null
  wasteValueInrMonth: number
  topAnomaly: { poNumber: string; variancePercent: number; jobCardNumber: number } | null
}> {
  const activeStatuses = ['design_ready', 'in_progress', 'final_qc', 'qa_released']
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)

  const activeJobs = await db.productionJobCard.findMany({
    where: { status: { in: activeStatuses } },
    include: { stages: true },
  })

  const monthJobs = await db.productionJobCard.findMany({
    where: {
      jobDate: { gte: monthStart, lte: monthEnd },
    },
    include: { stages: true },
  })

  const numbers = Array.from(new Set([...activeJobs, ...monthJobs].map((j) => j.jobCardNumber)))
  const lines =
    numbers.length === 0
      ? []
      : await db.poLineItem.findMany({
          where: { jobCardNumber: { in: numbers } },
          include: {
            po: { select: { poNumber: true } },
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
  const lineByJc = new Map<number, (typeof lines)[0]>()
  for (const li of lines) {
    if (li.jobCardNumber != null) lineByJc.set(li.jobCardNumber, li)
  }

  async function metricsFor(
    list: typeof activeJobs,
  ): Promise<Array<{ m: JobYieldMetrics; poNumber: string | null; jobCardNumber: number }>> {
    const out: Array<{ m: JobYieldMetrics; poNumber: string | null; jobCardNumber: number }> = []
    for (const j of list) {
      const li = lineByJc.get(j.jobCardNumber) ?? null
      const m = await computeJobYieldMetricsForCard(db, j, li)
      out.push({ m, poNumber: li?.po.poNumber ?? null, jobCardNumber: j.jobCardNumber })
    }
    return out
  }

  const activeMetrics = await metricsFor(activeJobs)
  const yields = activeMetrics.map((x) => x.m.yieldPercent).filter((y): y is number => y != null)
  const netYieldPercent =
    yields.length > 0 ? Math.round((yields.reduce((a, b) => a + b, 0) / yields.length) * 10) / 10 : null

  let topAnomaly: { poNumber: string; variancePercent: number; jobCardNumber: number } | null = null
  for (const row of activeMetrics) {
    const v = row.m.wastageVariancePercent
    if (v == null || v <= 0) continue
    if (!topAnomaly || v > topAnomaly.variancePercent) {
      topAnomaly = {
        poNumber: row.poNumber ?? `JC#${row.jobCardNumber}`,
        variancePercent: v,
        jobCardNumber: row.jobCardNumber,
      }
    }
  }

  const monthMetrics = await metricsFor(monthJobs)
  let wasteValueInrMonth = 0
  for (const row of monthMetrics) {
    const m = row.m
    if (
      m.theoreticalWeightKg == null ||
      m.actualIssuedWeightKg == null ||
      m.actualIssuedWeightKg <= m.theoreticalWeightKg
    )
      continue
    const wasteKg = m.actualIssuedWeightKg - m.theoreticalWeightKg
    const jobId = monthJobs.find((j) => j.jobCardNumber === row.jobCardNumber)?.id
    const jobIssues = jobId
      ? await db.paperIssueToFloor.findMany({
          where: { productionJobCardId: jobId },
          take: 6,
          include: { source: { select: { rate: true, gsm: true, boardGrade: true, paperType: true } } },
        })
      : []
    let inrPerKg = 0
    for (const iss of jobIssues) {
      const kps =
        (await resolveKgPerSheetForPaper(db, iss.source)) ?? fallbackKgPerSheetFromGsm(iss.source.gsm)
      const rate = iss.source.rate != null ? Number(iss.source.rate) : 0
      if (kps > 0 && rate > 0) {
        inrPerKg = rate / kps
        break
      }
    }
    wasteValueInrMonth += wasteKg * inrPerKg
  }

  wasteValueInrMonth = Math.round(wasteValueInrMonth * 100) / 100

  return { netYieldPercent, wasteValueInrMonth, topAnomaly }
}
