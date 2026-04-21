import type { Prisma } from '@prisma/client'
import { CUSTODY_IN_STOCK, CUSTODY_PREPARING_FOR_PRODUCTION } from '@/lib/inventory-hub-custody'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { createEmbossHubEvent, EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'
import { dieHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'
import { embossHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'

type Tx = Prisma.TransactionClient

/**
 * Return die + emboss from “reserved for job” to rack when PO line is closed or recalled from designing.
 */
export async function releaseReservedToolingForPoLine(
  tx: Tx,
  args: { poLineItemId: string; actorName: string; reason: string },
): Promise<{ dieReleased: boolean; embossReleased: boolean }> {
  const line = await tx.poLineItem.findUnique({
    where: { id: args.poLineItemId },
    select: {
      id: true,
      dieMasterId: true,
      jobCardNumber: true,
      cartonId: true,
    },
  })
  if (!line) return { dieReleased: false, embossReleased: false }

  let dieReleased = false
  let embossReleased = false

  const jc = line.jobCardNumber
    ? await tx.productionJobCard.findFirst({
        where: { jobCardNumber: line.jobCardNumber },
        select: { id: true, jobCardNumber: true },
      })
    : null

  if (line.dieMasterId) {
    const dye = await tx.dye.findUnique({
      where: { id: line.dieMasterId },
      select: { id: true, dyeNumber: true, custodyStatus: true, hubPreviousCustody: true },
    })
    if (dye?.custodyStatus === CUSTODY_PREPARING_FOR_PRODUCTION) {
      const back = dye.hubPreviousCustody?.trim() || CUSTODY_IN_STOCK
      await tx.dye.update({
        where: { id: dye.id },
        data: {
          custodyStatus: back,
          hubPreviousCustody: null,
        },
      })
      await createDieHubEvent(tx, {
        dyeId: dye.id,
        actionType: DIE_HUB_ACTION.RETURN_TO_RACK,
        fromZone: dieHubZoneLabelFromCustody(CUSTODY_PREPARING_FOR_PRODUCTION),
        toZone: dieHubZoneLabelFromCustody(back),
        actorName: args.actorName,
        details: {
          message: `Designing release — die #${dye.dyeNumber} returned to rack (${args.reason}).`,
          poLineId: line.id,
          jobCardId: jc?.id ?? null,
          jobCardNumber: jc?.jobCardNumber ?? null,
        },
      })
      dieReleased = true
    }
  }

  if (line.cartonId) {
    const carton = await tx.carton.findUnique({
      where: { id: line.cartonId },
      select: { embossBlockId: true },
    })
    const blockId = carton?.embossBlockId?.trim()
    if (blockId) {
      const block = await tx.embossBlock.findUnique({
        where: { id: blockId },
        select: { id: true, blockCode: true, custodyStatus: true, hubPreviousCustody: true },
      })
      if (block?.custodyStatus === CUSTODY_PREPARING_FOR_PRODUCTION) {
        const back = block.hubPreviousCustody?.trim() || CUSTODY_IN_STOCK
        await tx.embossBlock.update({
          where: { id: block.id },
          data: {
            custodyStatus: back,
            hubPreviousCustody: null,
          },
        })
        await createEmbossHubEvent(tx, {
          blockId: block.id,
          actionType: EMBOSS_HUB_ACTION.RETURN_TO_RACK,
          fromZone: embossHubZoneLabelFromCustody(CUSTODY_PREPARING_FOR_PRODUCTION),
          toZone: embossHubZoneLabelFromCustody(back),
          details: {
            message: `Designing release — emboss ${block.blockCode} returned to rack (${args.reason}).`,
            poLineId: line.id,
            jobCardId: jc?.id ?? null,
            jobCardNumber: jc?.jobCardNumber ?? null,
          },
        })
        embossReleased = true
      }
    }
  }

  return { dieReleased, embossReleased }
}
