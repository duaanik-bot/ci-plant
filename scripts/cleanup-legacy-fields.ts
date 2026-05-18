/**
 * cleanup-legacy-fields.ts — final correctness pass on legacy_recovery cartons:
 *   • coatingType NULL  → 'None'  (legacy had no coating = uncoated)
 *   • embossingLeafing stored as a legacy numeric id ('0','1','3', '') → null
 *     (those are raw ids, not valid labels; no legacy lookup exists)
 * Board grade & UPS are intentionally left blank (per instruction / absent).
 *
 * USAGE: npx tsx scripts/cleanup-legacy-fields.ts [--confirm]
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
const CONFIRM = process.argv.includes('--confirm')

async function main() {
  const rows = await prisma.carton.findMany({
    where: { source: 'legacy_recovery' },
    select: { id: true, coatingType: true, embossingLeafing: true },
  })
  let coat = 0
  let emb = 0
  const ups: { id: string; data: Record<string, unknown> }[] = []
  for (const r of rows) {
    const d: Record<string, unknown> = {}
    if (r.coatingType == null) {
      d.coatingType = 'None'
      coat++
    }
    if (r.embossingLeafing != null && /^\s*\d*\s*$/.test(r.embossingLeafing)) {
      d.embossingLeafing = null
      emb++
    }
    if (Object.keys(d).length) ups.push({ id: r.id, data: d })
  }
  console.log('── legacy field cleanup ──')
  console.table({ scanned: rows.length, coatingToNone: coat, embossingCleared: emb, mode: CONFIRM ? 'WRITE' : 'DRY-RUN' })
  if (!CONFIRM) { console.log('DRY-RUN — add --confirm to apply.'); return }
  for (let i = 0; i < ups.length; i += 200)
    await prisma.$transaction(ups.slice(i, i + 200).map((u) => prisma.carton.update({ where: { id: u.id }, data: u.data })))
  console.log(`✅ Cleaned ${ups.length} carton(s).`)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
