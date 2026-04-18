import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { computeLiveOeeForJobCard } from '@/lib/production-oee'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const jc = await db.productionJobCard.findUnique({
    where: { id },
    include: {
      machine: { select: { capacityPerShift: true, machineCode: true } },
      shiftOperator: { select: { id: true, name: true } },
      stages: { orderBy: { createdAt: 'asc' } },
      embossBlock: { select: { blockCode: true, id: true } },
    },
  })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const poLine = jc.jobCardNumber
    ? await db.poLineItem.findFirst({
        where: { jobCardNumber: jc.jobCardNumber },
        select: {
          dieMaster: { select: { dyeNumber: true, id: true } },
          shadeCard: { select: { shadeCode: true, id: true } },
        },
      })
    : null

  const printStage =
    jc.stages.find((s) => s.stageName === 'Printing' && s.status === 'in_progress') ??
    jc.stages.find((s) => s.status === 'in_progress') ??
    jc.stages.find((s) => s.stageName === 'Printing') ??
    null

  let liveOee: Awaited<ReturnType<typeof computeLiveOeeForJobCard>> = null
  if (printStage) {
    liveOee = await computeLiveOeeForJobCard(
      db,
      {
        id: jc.id,
        createdAt: jc.createdAt,
        totalSheets: jc.totalSheets,
        wastageSheets: jc.wastageSheets,
        status: jc.status,
        machineId: jc.machineId,
        machine: jc.machine,
      },
      printStage,
    )
  }

  const [sheetIssues, downtimeLogs, shadeIssuedToJob] = await Promise.all([
    db.sheetIssueRecord.findMany({
      where: { jobCardId: id },
      orderBy: { issuedAt: 'asc' },
    }),
    db.productionDowntimeLog.findMany({
      where: { productionJobCardId: id },
      orderBy: { startedAt: 'asc' },
    }),
    db.shadeCard.findMany({
      where: { issuedJobCardId: id },
      select: { id: true, shadeCode: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const setupSheets = jc.wastageSheets
  const runningWasteSheets = sheetIssues
    .filter((r) => r.isExcess)
    .reduce((sum, r) => sum + r.qtyRequested, 0)

  const remarksTimeline: { at: string; kind: string; text: string }[] = [
    ...downtimeLogs.map((d) => ({
      at: d.startedAt.toISOString(),
      kind: 'downtime',
      text: [d.reasonCategory, d.notes].filter(Boolean).join(' — ') || 'Downtime',
    })),
    ...sheetIssues.map((s) => ({
      at: s.issuedAt.toISOString(),
      kind: 'sheet',
      text:
        s.reasonDetail ||
        s.reasonCode ||
        `Sheet issue ${s.qtyRequested} sh${s.isExcess ? ' (excess)' : ''}`,
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  const dieExpected = poLine?.dieMaster?.dyeNumber ?? null
  const shadeExpected = poLine?.shadeCard?.shadeCode ?? null
  const embossOnCard = jc.embossBlock?.blockCode ?? null
  const shadeOnFloor =
    shadeIssuedToJob.length > 0 ? shadeIssuedToJob.map((s) => s.shadeCode).filter(Boolean) : []
  const shadeMatch =
    shadeExpected != null && shadeOnFloor.length > 0
      ? shadeOnFloor.some((c) => c === shadeExpected)
      : null
  const dieMatch =
    dieExpected != null && embossOnCard
      ? embossOnCard.replace(/\D/g, '') === String(dieExpected).replace(/\D/g, '') ||
        embossOnCard.toLowerCase().includes(String(dieExpected).toLowerCase())
      : null

  return NextResponse.json({
    jobCardNumber: jc.jobCardNumber,
    liveOee,
    waste: {
      setupSheets,
      runningWasteSheets,
      sheetIssueCount: sheetIssues.length,
    },
    tooling: {
      dieNumberSpec: dieExpected,
      shadeCodeSpec: shadeExpected,
      embossBlockCode: embossOnCard,
      shadeCodesIssued: shadeOnFloor,
      dieLinked: poLine?.dieMaster?.id ?? null,
      shadeLinked: poLine?.shadeCard?.id ?? null,
      embossLinkedId: jc.embossBlockId,
      verification: {
        shadeMatch,
        dieMatch,
      },
    },
    remarksTimeline,
  })
}
