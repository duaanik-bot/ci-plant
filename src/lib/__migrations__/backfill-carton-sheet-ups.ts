import { db } from '@/lib/db'
import { writeFileSync } from 'node:fs'

/**
 * One-time, idempotent: move legacy Sheet Size (blankLength/blankWidth) and
 * UPS (specialInstructions JSON) into the dedicated sheetSizeL/W/ups columns.
 * Only fills columns that are currently null. Logs before-values.
 */
async function main() {
  const rows = await db.carton.findMany({
    select: {
      id: true, blankLength: true, blankWidth: true, ups: true,
      sheetSizeL: true, sheetSizeW: true, specialInstructions: true,
    },
  })
  const log: Array<Record<string, unknown>> = []
  for (const r of rows) {
    const data: Record<string, unknown> = {}
    if (r.sheetSizeL == null && r.blankLength != null) data.sheetSizeL = r.blankLength
    if (r.sheetSizeW == null && r.blankWidth != null) data.sheetSizeW = r.blankWidth
    if (r.ups == null && typeof r.specialInstructions === 'string') {
      try {
        const o = JSON.parse(r.specialInstructions) as Record<string, unknown>
        const n = Number(o.ups)
        if (Number.isFinite(n) && n > 0) {
          data.ups = Math.floor(n)
          delete o.ups
          data.specialInstructions = JSON.stringify(o)
        }
      } catch { /* leave as-is */ }
    }
    if (Object.keys(data).length > 0) {
      log.push({ id: r.id, before: {
        sheetSizeL: r.sheetSizeL, sheetSizeW: r.sheetSizeW, ups: r.ups,
      }, applied: data })
      await db.carton.update({ where: { id: r.id }, data })
    }
  }
  writeFileSync(
    'docs/carton-sheet-ups-backfill-log.json',
    JSON.stringify({ at: new Date().toISOString(), count: log.length, log }, null, 2),
  )
  console.log(`Backfilled ${log.length} carton(s). Log: docs/carton-sheet-ups-backfill-log.json`)
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
