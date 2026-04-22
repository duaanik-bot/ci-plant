import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Product master + last job runs + hub hints for Planning drawer. */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ cartonId: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { cartonId } = await context.params
  if (!cartonId) return NextResponse.json({ error: 'cartonId required' }, { status: 400 })

  const carton = await db.carton.findUnique({
    where: { id: cartonId },
    include: {
      customer: { select: { id: true, name: true } },
      dieMaster: { select: { dyeNumber: true, ups: true, sheetSize: true } },
      dye: { select: { id: true, dyeNumber: true } },
      shadeCard: { select: { id: true, shadeCode: true, custodyStatus: true } },
    },
  })

  if (!carton) return NextResponse.json({ error: 'Product not found' }, { status: 404 })

  const lines = await db.poLineItem.findMany({
    where: { cartonId, jobCardNumber: { not: null } },
    select: { jobCardNumber: true },
    orderBy: { createdAt: 'desc' },
  })

  const seen = new Set<number>()
  const jobNumbers: number[] = []
  for (const l of lines) {
    if (l.jobCardNumber == null) continue
    if (seen.has(l.jobCardNumber)) continue
    seen.add(l.jobCardNumber)
    jobNumbers.push(l.jobCardNumber)
    if (jobNumbers.length >= 8) break
  }

  const lastRuns = jobNumbers.length
    ? await db.productionJobCard.findMany({
        where: { jobCardNumber: { in: jobNumbers } },
        select: {
          jobCardNumber: true,
          jobDate: true,
          status: true,
          qaReleased: true,
          grainFitStatus: true,
          issuedStockDisplay: true,
        },
        orderBy: { jobDate: 'desc' },
        take: 5,
      })
    : []

  const specGrain =
    carton.specialInstructions?.toLowerCase().includes('grain') ||
    carton.remarks?.toLowerCase().includes('grain')
      ? (carton.specialInstructions || carton.remarks || '').trim()
      : 'Follow master special instructions; verify against latest die layout.'

  return NextResponse.json({
    master: {
      id: carton.id,
      cartonName: carton.cartonName,
      gsm: carton.gsm,
      paperType: carton.paperType,
      boardGrade: carton.boardGrade,
      coatingType: carton.coatingType,
      laminateType: carton.laminateType,
      embossingLeafing: carton.embossingLeafing,
      artworkCode: carton.artworkCode,
      blankLength: carton.blankLength != null ? Number(carton.blankLength) : null,
      blankWidth: carton.blankWidth != null ? Number(carton.blankWidth) : null,
    },
    customer: carton.customer,
    hub: {
      die: carton.dieMaster
        ? { dyeNumber: carton.dieMaster.dyeNumber, ups: carton.dieMaster.ups, sheetSize: carton.dieMaster.sheetSize }
        : null,
      dyeId: carton.dyeId,
      shadeCard: carton.shadeCard,
    },
    grainDirectionNote: specGrain,
    lastRuns: lastRuns.map((j) => ({
      jobCardNumber: j.jobCardNumber,
      jobDate: j.jobDate,
      status: j.status,
      qaReleased: j.qaReleased,
      grainFitStatus: j.grainFitStatus,
      issuedStockDisplay: j.issuedStockDisplay,
    })),
  })
}
