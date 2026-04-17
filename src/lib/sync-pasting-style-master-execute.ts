import { PastingStyle } from '@prisma/client'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'

const ALLOWED = new Set<PastingStyle>([PastingStyle.LOCK_BOTTOM, PastingStyle.BSO])

/**
 * Product Master (`carton`) + linked Die records (`dye` via dieMasterId / dyeId).
 * Used by PO one-click sync (API + server action).
 */
export async function executeSyncPastingStyleToMaster(args: {
  cartonId: string
  pastingStyle: PastingStyle
  userId: string
  actorLabel: string
}): Promise<{ ok: true; cartonName: string } | { ok: false; error: string; status?: number }> {
  const id = args.cartonId.trim()
  if (!id) return { ok: false, error: 'Carton id required', status: 400 }
  if (!ALLOWED.has(args.pastingStyle)) {
    return { ok: false, error: 'Only Lock Bottom or BSO is allowed', status: 400 }
  }

  const row = await db.carton.findUnique({
    where: { id },
    select: { id: true, cartonName: true, pastingStyle: true, dieMasterId: true, dyeId: true },
  })
  if (!row) return { ok: false, error: 'Not found', status: 404 }

  const next = args.pastingStyle

  await db.$transaction(async (tx) => {
    await tx.carton.update({
      where: { id },
      data: { pastingStyle: next },
    })
    const dyeIds = [row.dieMasterId?.trim(), row.dyeId?.trim()].filter(Boolean) as string[]
    if (dyeIds.length > 0) {
      await tx.dye.updateMany({
        where: { id: { in: dyeIds } },
        data: { pastingStyle: next },
      })
    }
  })

  const summary = `Product Master ${row.cartonName} updated via PO Form by ${args.actorLabel}.`

  await createAuditLog({
    userId: args.userId,
    action: 'UPDATE',
    tableName: 'cartons',
    recordId: id,
    oldValue: { pastingStyle: row.pastingStyle, cartonName: row.cartonName },
    newValue: {
      pastingStyle: next,
      summary,
      source: 'po_form_sync_pasting_style_to_master',
      linkedDieIdsUpdated: [row.dieMasterId, row.dyeId].filter(Boolean),
    },
  })

  return { ok: true, cartonName: row.cartonName }
}
