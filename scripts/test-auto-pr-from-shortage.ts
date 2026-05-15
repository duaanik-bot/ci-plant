/**
 * Smoke test: maybeCreateDraftPrForShortage
 * Run (locally, with a non-prod DB): npx tsx scripts/test-auto-pr-from-shortage.ts
 */
import { PrismaClient } from '@prisma/client'
import { maybeCreateDraftPrForShortage } from '../src/lib/auto-pr-from-shortage'

const prisma = new PrismaClient()

async function main() {
  const candidates = await prisma.inventory.findMany({ select: { id: true }, take: 50 })
  let materialId: string | null = null
  for (const c of candidates) {
    const open = await prisma.purchaseRequisition.findFirst({
      where: { materialId: c.id, status: { in: ['draft', 'pending', 'approved'] } },
    })
    if (!open) {
      materialId = c.id
      break
    }
  }
  if (!materialId) {
    console.log('SKIP: every sampled material already has an open PR')
    return
  }

  // Test 1: creates a PR
  const created = await prisma.$transaction(async (tx) =>
    maybeCreateDraftPrForShortage(materialId!, 100, tx),
  )
  console.assert(created !== null, 'should have created a PR')
  console.assert(created!.status === 'draft', `status should be draft, got ${created!.status}`)
  console.assert(created!.raisedBy === null, `raisedBy should be null, got ${created!.raisedBy}`)
  console.log('PASS: creates draft PR')

  // Test 2: dedupe
  const second = await prisma.$transaction(async (tx) =>
    maybeCreateDraftPrForShortage(materialId!, 100, tx),
  )
  console.assert(second === null, `second call should return null (dedupe), got ${second?.id}`)
  console.log('PASS: dedupes on open PR existing')

  // Test 3: shortage=0 short-circuit
  await prisma.purchaseRequisition.delete({ where: { id: created!.id } })
  const zero = await prisma.$transaction(async (tx) =>
    maybeCreateDraftPrForShortage(materialId!, 0, tx),
  )
  console.assert(zero === null, 'shortage=0 should return null')
  console.log('PASS: shortage=0 short-circuit')
}

main()
  .catch((e) => {
    console.error('FAIL:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
