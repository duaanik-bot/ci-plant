/**
 * migrate-cartons.ts — imports the "Carton Master Bible" Excel into `cartons`.
 *
 * USAGE:
 *   npx tsx scripts/migrate-cartons.ts "<path-to.xlsx>"            # dry-run
 *   npx tsx scripts/migrate-cartons.ts "<path-to.xlsx>" --confirm  # real insert
 *
 * Sheet: "Carton Master Bible" (else first sheet). Row 0 title, row 1 subtitle,
 * row 2 header, data from row 3. Column order:
 *   0 Carton (Product Name)  1 Customer   2 Colour   3 Sheet Size
 *   4 UPS   5 Board Type   6 Category   7 Coating   8 Pasting Type
 *   9 Panel Size (LxWxH)   10 Rate (₹)   11 GSM
 *
 * Board Type → boardGrade + paperType via mapBoardType (legacy White→Saffire,
 * legacy Yellow/FBB Plain→FBB, GB/WB→Duplex, FBB Coated→distinct master).
 * Highlighted rows with missing process-colour count import with numberOfColours = null.
 * Failures written to failed-rows.csv.
 */
import { PrismaClient } from '@prisma/client'
import * as XLSX from 'xlsx'
import * as fs from 'fs'
import {
  parseDims,
  parseSheetSize,
  parseColours,
  mapPastingStyle,
  mapBoardType,
  parseRate,
  parseGsm,
} from '../src/lib/carton/parse'
import {
  canonicalBoardGrade,
  canonicalCoating,
  canonicalPrintingType,
} from '../src/lib/carton/canonical'

const prisma = new PrismaClient()
const CONFIRM = process.argv.includes('--confirm')
const filePath = process.argv.slice(2).find((a) => !a.startsWith('--'))

type Row = (string | null)[]

async function main() {
  if (!filePath || !fs.existsSync(filePath)) {
    console.error('Excel path required and must exist. Got:', filePath)
    process.exit(1)
  }
  const wb = XLSX.readFile(filePath)
  const sheetName =
    wb.SheetNames.find((n) => n === 'Carton Master Bible') ?? wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<Row>(ws, { header: 1, raw: false })
  const dataRows = rows.slice(3)

  const customerCache = new Map<string, string>()
  const failed: { row: number; name: string; reason: string }[] = []
  const newMasters = new Set<string>()
  let success = 0
  let skipped = 0

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const excelRowNo = i + 4 // 1-based incl. title/subtitle/header
    const cartonName = (r?.[0] ?? '').toString().trim()
    const customerName = (r?.[1] ?? '').toString().trim()

    if (!cartonName) {
      skipped++
      continue
    }
    if (!customerName) {
      failed.push({ row: excelRowNo, name: cartonName, reason: 'missing Customer' })
      continue
    }

    try {
      const dims = parseDims(r[9] as string)
      const sheet = parseSheetSize(r[3] as string)
      const board = mapBoardType(r[5] as string)
      const upsRaw = r[4] != null ? String(r[4]).trim() : ''
      const ups = upsRaw && Number.isFinite(Number(upsRaw)) ? parseInt(upsRaw, 10) : null
      const rawPasting = (r[8] ?? '').toString().trim()
      const pastingStyle = mapPastingStyle(rawPasting)
      if (rawPasting && pastingStyle == null) {
        console.warn(`row ${excelRowNo}: unmapped Pasting Type "${rawPasting}" → null`)
      }
      if (board.boardGrade === 'FBB coated') newMasters.add(cartonName)

      const rec = {
        cartonName,
        numberOfColours: parseColours(r[2] as string),
        sheetSizeL: sheet.l,
        sheetSizeW: sheet.w,
        ups,
        boardGrade: canonicalBoardGrade(board.boardGrade),
        paperType: board.paperType,
        category: (r[6] ?? null) as string | null,
        printingType: canonicalPrintingType(r[6] as string),
        coatingType: canonicalCoating(r[7] as string),
        pastingStyle,
        finishedLength: dims.l,
        finishedWidth: dims.w,
        finishedHeight: dims.h,
        rate: parseRate(r[10] as string),
        gsm: parseGsm(r[11] as string),
      }

      if (!CONFIRM) {
        success++
        continue
      }

      let customerId = customerCache.get(customerName.toLowerCase())
      if (!customerId) {
        const existing = await prisma.customer.findFirst({
          where: { name: { equals: customerName, mode: 'insensitive' } },
          select: { id: true },
        })
        customerId =
          existing?.id ??
          (
            await prisma.customer.create({
              data: { name: customerName, source: 'carton_bible_import' },
              select: { id: true },
            })
          ).id
        customerCache.set(customerName.toLowerCase(), customerId)
      }

      await prisma.carton.create({
        data: { ...rec, customerId, source: 'carton_bible_import' },
      })
      success++
    } catch (e) {
      failed.push({
        row: excelRowNo,
        name: cartonName,
        reason: (e as Error).message,
      })
    }
  }

  console.log('── Import summary ──')
  console.table({
    total: dataRows.length,
    success,
    failed: failed.length,
    skipped,
    fbb_coated_new_masters: newMasters.size,
    mode: CONFIRM ? 'WRITE' : 'DRY-RUN',
  })
  if (newMasters.size) {
    console.log(
      `FBB coated → new masters flagged: ${[...newMasters].slice(0, 10).join(', ')}${newMasters.size > 10 ? ' …' : ''}`,
    )
  }

  if (failed.length) {
    const csv =
      'excel_row,carton_name,reason\n' +
      failed
        .map(
          (f) =>
            `${f.row},"${f.name.replace(/"/g, '""')}","${f.reason.replace(/"/g, '""')}"`,
        )
        .join('\n')
    fs.writeFileSync('failed-rows.csv', csv)
    console.log(`Wrote failed-rows.csv (${failed.length} rows).`)
  }
  if (!CONFIRM) console.log('\nDRY-RUN — no rows written. Add --confirm to insert.')
}

main()
  .catch((e) => {
    console.error('Import failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
