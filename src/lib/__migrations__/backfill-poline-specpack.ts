import { db } from '@/lib/db'
import { buildCartonSpecPack } from '@/lib/carton-spec-pack'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Best-effort baseline: populate specPack for OPEN po lines that have a
 * cartonId but no pack yet. Closed/dispatched lines are left untouched.
 * Idempotent (skips lines that already have a pack).
 */

const log: Array<Record<string, unknown>> = []

function flushLog(partial: boolean) {
  writeFileSync(
    resolve(process.cwd(), 'docs/poline-specpack-backfill-log.json'),
    JSON.stringify({ at: new Date().toISOString(), partial, count: log.length, log }, null, 2),
  )
}

async function main() {
  const lines = await db.poLineItem.findMany({
    where: {
      specPack: { equals: null },
      cartonId: { not: null },
      po: {
        status: {
          // Terminal PO statuses excluded from backfill (verified 2026-05-19): ['closed'].
          // Full PO status vocabulary is draft -> confirmed -> sent_to_planning -> closed
          // (default 'draft' per prisma/schema.prisma:912; no 'dispatched'/'cancelled' exist).
          // 'closed' is the only terminal state — src/app/api/purchase-orders/[id]/route.ts:195
          // permits only 'closed' as the forward move from sent_to_planning and nothing exits 'closed'.
          notIn: ['closed'],
        },
      },
    },
    select: { id: true, cartonId: true },
  })
  let n = 0
  for (const l of lines) {
    const c = await db.carton.findUnique({ where: { id: l.cartonId! } })
    if (!c) continue
    log.push({ id: l.id, cartonId: l.cartonId })
    await db.poLineItem.update({
      where: { id: l.id },
      data: { specPack: buildCartonSpecPack(c) as object },
    })
    n++
  }
  flushLog(false)
  console.log(`Backfilled specPack on ${n} open po line(s).`)
  await db.$disconnect()
}

main().catch((e) => { if (log.length) flushLog(true); console.error(e); process.exit(1) })
