/**
 * wipe-cartons.ts — DESTRUCTIVE. Removes all cartons and the records that
 * FK-reference a carton. Does NOT touch customers, dyes, shade cards,
 * users, or PurchaseOrder headers.
 *
 * FK reality (verified against schema):
 *   - PoLineItem.cartonId  → carton-derived transactional rows: DELETED
 *   - PlateStore.cartonId  → DELETED (PlateStoreScrapEvent cascades via
 *                            onDelete:Cascade; PlateHubEvent.plateStoreId
 *                            is onDelete:SetNull → auto-nulled)
 *   - EmbossBlock.cartonId → emboss tooling MASTER (not carton-derived):
 *                            cartonId set to NULL (block + its hub/usage
 *                            history preserved). Re-run with
 *                            --delete-emboss to hard-delete instead.
 *   - ShadeCard.productId  → onDelete:SetNull → auto-nulled by Prisma.
 *
 * IDs are UUIDs — there are NO auto-increment sequences to reset (no-op).
 *
 * USAGE:
 *   npx tsx scripts/wipe-cartons.ts                   # dry-run, counts only
 *   npx tsx scripts/wipe-cartons.ts --confirm         # REAL wipe
 *   npx tsx scripts/wipe-cartons.ts --confirm --delete-emboss
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const CONFIRM = process.argv.includes('--confirm')
const DELETE_EMBOSS = process.argv.includes('--delete-emboss')

async function main() {
  const cartonIds = (await prisma.carton.findMany({ select: { id: true } })).map(
    (c) => c.id,
  )

  const counts = {
    cartons: cartonIds.length,
    poLineItems_DELETE: await prisma.poLineItem.count({
      where: { cartonId: { in: cartonIds } },
    }),
    plateStores_DELETE: await prisma.plateStore.count({
      where: { cartonId: { in: cartonIds } },
    }),
    embossBlocks_linked: await prisma.embossBlock.count({
      where: { cartonId: { in: cartonIds } },
    }),
  }

  console.log('── Carton wipe — impact ──')
  console.table(counts)
  console.log(
    `EmbossBlock policy: ${DELETE_EMBOSS ? 'HARD DELETE blocks' : 'unlink (cartonId = NULL), block + history preserved'}`,
  )
  console.log('NOTE: deleting PO line items leaves their PurchaseOrder headers empty.')

  if (!CONFIRM) {
    console.log('\nDRY-RUN. Re-run with --confirm to execute the wipe.')
    return
  }

  await prisma.$transaction(async (tx) => {
    await tx.poLineItem.deleteMany({ where: { cartonId: { in: cartonIds } } })
    await tx.plateStore.deleteMany({ where: { cartonId: { in: cartonIds } } })
    if (DELETE_EMBOSS) {
      await tx.embossBlock.deleteMany({ where: { cartonId: { in: cartonIds } } })
    } else {
      await tx.embossBlock.updateMany({
        where: { cartonId: { in: cartonIds } },
        data: { cartonId: null },
      })
    }
    await tx.carton.deleteMany({})
  })

  console.log('✅ Wipe complete. Auto-increment sequence reset: N/A (UUID PKs).')
}

main()
  .catch((e) => {
    console.error('Wipe failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
