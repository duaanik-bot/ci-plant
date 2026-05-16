/**
 * Smoke test: computeAvgDailyConsumption
 * Run (locally, with a non-prod DB): npx tsx scripts/test-days-of-cover.ts
 */
import { PrismaClient } from '@prisma/client'
import { computeAvgDailyConsumption } from '../src/lib/material-readiness-service'

const prisma = new PrismaClient()

async function main() {
  const materials = await prisma.inventory.findMany({ select: { id: true }, take: 20 })
  const ids = materials.map((m) => m.id)
  const result = await computeAvgDailyConsumption(ids)

  console.log(`Computed consumption for ${result.size} of ${ids.length} materials`)
  for (const [mid, avg] of result) {
    console.assert(avg >= 0, `avg should be non-negative for ${mid}`)
  }

  if (result.size > 0) {
    console.log('Sample:', Array.from(result.entries()).slice(0, 3))
  }
  console.log('PASS: computeAvgDailyConsumption')
}

main()
  .catch((e) => {
    console.error('FAIL:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
