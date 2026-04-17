import { PastingStyle } from '@prisma/client'
import { db } from '@/lib/db'
import { CUSTODY_HUB_TRIAGE } from '@/lib/inventory-hub-custody'

/**
 * When Product Master pasting changes, align any **triage** dies tied to this carton
 * (die master link or work-dye link) so the Die Hub queue stays in sync.
 */
export async function syncTriageDiesPastingForCarton(
  cartonId: string,
  pastingStyle: PastingStyle | null,
): Promise<void> {
  const carton = await db.carton.findUnique({
    where: { id: cartonId },
    select: { dieMasterId: true, dyeId: true },
  })
  if (!carton) return
  const dyeIds = new Set<string>()
  if (carton.dieMasterId?.trim()) dyeIds.add(carton.dieMasterId.trim())
  if (carton.dyeId?.trim()) dyeIds.add(carton.dyeId.trim())
  if (dyeIds.size === 0) return
  await db.dye.updateMany({
    where: {
      id: { in: Array.from(dyeIds) },
      custodyStatus: CUSTODY_HUB_TRIAGE,
    },
    data: { pastingStyle },
  })
}
