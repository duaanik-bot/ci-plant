/**
 * normalize-carton-vocab.ts — one-time fix for cartons already imported from
 * the Carton Master Bible before canonical-vocabulary mapping existed.
 *
 * Rewrites boardGrade / coatingType / printingType to the app's canonical
 * dropdown vocabulary (src/lib/master-enums.ts) so the Carton Master form
 * dropdowns and the list render correctly. paperType (shade) is untouched.
 * Non-destructive: only UPDATEs three text columns on source=carton_bible_import.
 *
 * USAGE:
 *   npx tsx scripts/normalize-carton-vocab.ts            # dry-run, counts only
 *   npx tsx scripts/normalize-carton-vocab.ts --confirm  # apply
 */
import { PrismaClient } from '@prisma/client'
import {
  canonicalBoardGrade,
  canonicalCoating,
  canonicalPrintingType,
} from '../src/lib/carton/canonical'

const prisma = new PrismaClient()
const CONFIRM = process.argv.includes('--confirm')

async function main() {
  const rows = await prisma.carton.findMany({
    where: { source: 'carton_bible_import' },
    select: { id: true, boardGrade: true, coatingType: true, printingType: true },
  })

  let changed = 0
  const updates: { id: string; data: Record<string, string | null> }[] = []
  for (const r of rows) {
    const next = {
      boardGrade: canonicalBoardGrade(r.boardGrade),
      coatingType: canonicalCoating(r.coatingType),
      printingType: canonicalPrintingType(r.printingType),
    }
    if (
      next.boardGrade !== r.boardGrade ||
      next.coatingType !== r.coatingType ||
      next.printingType !== r.printingType
    ) {
      changed++
      updates.push({ id: r.id, data: next })
    }
  }

  console.log('── Carton vocab normalization ──')
  console.table({
    total: rows.length,
    rowsToChange: changed,
    mode: CONFIRM ? 'WRITE' : 'DRY-RUN',
  })

  if (!CONFIRM) {
    console.log(
      'Sample:',
      JSON.stringify(updates.slice(0, 3), null, 1),
      '\nDRY-RUN — no rows written. Add --confirm to apply.',
    )
    return
  }

  for (let i = 0; i < updates.length; i += 200) {
    const batch = updates.slice(i, i + 200)
    await prisma.$transaction(
      batch.map((u) =>
        prisma.carton.update({ where: { id: u.id }, data: u.data }),
      ),
    )
  }
  console.log(`✅ Normalized ${changed} carton(s).`)
}

main()
  .catch((e) => {
    console.error('Normalization failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
