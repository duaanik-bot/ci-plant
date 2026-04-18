import type { PrismaClient } from '@prisma/client'

/**
 * When a job card closes, add ledger / emboss-stage impressions to the linked emboss block
 * `cumulative_strikes` (and mirror `impression_count` + usage log).
 */
export async function incrementEmbossStrikesOnJobClose(
  db: PrismaClient,
  productionJobCardId: string,
  operatorName: string | null,
): Promise<void> {
  const [ledger, jc] = await Promise.all([
    db.productionOeeLedger.findUnique({
      where: { productionJobCardId },
      select: { totalPieces: true },
    }),
    db.productionJobCard.findUnique({
      where: { id: productionJobCardId },
      include: { stages: true },
    }),
  ])

  if (!jc) return

  const routing = jc.postPressRouting as { embossing?: boolean } | null
  const embossStage = jc.stages.find((s) => s.stageName === 'Embossing')
  const hasEmbossStage = Boolean(embossStage)

  let blockId = jc.embossBlockId
  if (!blockId && jc.jobCardNumber != null) {
    const poLine = await db.poLineItem.findFirst({
      where: { jobCardNumber: jc.jobCardNumber },
      select: { carton: { select: { embossBlockId: true } } },
    })
    blockId = poLine?.carton?.embossBlockId ?? null
  }

  if (!blockId) return

  const routingExplicitOff = routing?.embossing === false
  if (routingExplicitOff && !hasEmbossStage) return

  const fromEmbossCounter =
    embossStage?.counter != null && embossStage.counter > 0 ? embossStage.counter : 0
  const fromLedger = ledger?.totalPieces && ledger.totalPieces > 0 ? ledger.totalPieces : 0

  const delta = fromEmbossCounter > 0 ? fromEmbossCounter : fromLedger
  if (delta <= 0) return

  await db.$transaction([
    db.embossBlock.update({
      where: { id: blockId },
      data: {
        cumulativeStrikes: { increment: delta },
        impressionCount: { increment: delta },
      },
    }),
    db.embossBlockUsageLog.create({
      data: {
        blockId,
        jobCardId: jc.id,
        impressions: delta,
        usedOn: new Date(),
        operatorName: operatorName?.trim() || null,
        notes: 'Auto: job close production strikes',
      },
    }),
  ])
}
