import { db } from '@/lib/db'
import { buildCartonSpecPack } from '@/lib/carton-spec-pack'

/**
 * Best-effort baseline: populate specPack for OPEN po lines that have a
 * cartonId but no pack yet. Closed/dispatched lines are left untouched.
 * Idempotent (skips lines that already have a pack).
 */
async function main() {
  const lines = await db.poLineItem.findMany({
    where: {
      specPack: { equals: null },
      cartonId: { not: null },
      po: {
        status: {
          // TODO before running: verify these match the actual terminal PurchaseOrder.status values
          notIn: ['dispatched', 'closed', 'cancelled'],
        },
      },
    },
    select: { id: true, cartonId: true },
  })
  let n = 0
  for (const l of lines) {
    const c = await db.carton.findUnique({ where: { id: l.cartonId! } })
    if (!c) continue
    await db.poLineItem.update({
      where: { id: l.id },
      data: { specPack: buildCartonSpecPack(c) as object },
    })
    n++
  }
  console.log(`Backfilled specPack on ${n} open po line(s).`)
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
