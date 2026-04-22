import type { PrismaClient } from '@prisma/client'

/**
 * Returns `null` if delete is allowed; otherwise the customer PO number for the
 * "reserved in planning" error string.
 */
export async function getHubDeletePlanningBlockPoNumber(
  db: PrismaClient,
  asset: 'plate_requirement' | 'plate_store' | 'die' | 'emboss' | 'shade_card',
  id: string,
): Promise<string | null> {
  if (asset === 'die') {
    const line = await db.poLineItem.findFirst({
      where: {
        OR: [{ dieMasterId: id }, { dyeId: id }],
        planningStatus: { not: 'closed' },
      },
      include: { po: { select: { poNumber: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return line?.po.poNumber ?? null
  }

  if (asset === 'shade_card') {
    const line = await db.poLineItem.findFirst({
      where: { shadeCardId: id, planningStatus: { not: 'closed' } },
      include: { po: { select: { poNumber: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return line?.po.poNumber ?? null
  }

  if (asset === 'plate_requirement') {
    const req = await db.plateRequirement.findUnique({
      where: { id },
      select: { poLineId: true },
    })
    const poLineId = req?.poLineId?.trim()
    if (!poLineId) return null
    const line = await db.poLineItem.findUnique({
      where: { id: poLineId },
      include: { po: { select: { poNumber: true } } },
    })
    if (line && line.planningStatus !== 'closed') return line.po.poNumber
    return null
  }

  if (asset === 'plate_store' || asset === 'emboss') {
    const jcs = await db.productionJobCard.findMany({
      where: asset === 'plate_store' ? { plateSetId: id } : { embossBlockId: id },
      select: { jobCardNumber: true },
    })
    const nums = jcs.map((j) => j.jobCardNumber).filter((n): n is number => n != null)
    if (nums.length === 0) return null
    const line = await db.poLineItem.findFirst({
      where: {
        jobCardNumber: { in: nums },
        planningStatus: { not: 'closed' },
      },
      include: { po: { select: { poNumber: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return line?.po.poNumber ?? null
  }

  return null
}
