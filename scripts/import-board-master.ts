/**
 * Board Master full reseed.
 *
 * 1. Seeds the "Board Type" Mini Master with the abbreviations used by the
 *    material-code generator (Saffire, FBB, Duplex GB, Duplex WB, Paper).
 * 2. Deletes every row in `inventory` (assumes zero FK dependents — caller verified).
 * 3. Reads `data/Board Master Data /Board Master Data .xlsx`, parses the
 *    "Product- Gsm" column into (length × width × gsm), and inserts one
 *    inventory row per Excel row using the same formulas as the masters/materials API.
 *
 * Run with:  ./node_modules/.bin/tsx scripts/import-board-master.ts [--dry]
 */
import { PrismaClient, Prisma } from '@prisma/client'
import * as XLSX from 'xlsx'
import * as path from 'path'

const db = new PrismaClient()

const EXCEL_PATH = path.join(process.cwd(), 'data', 'Board Master Data ', 'Board Master Data .xlsx')
const DRY_RUN = process.argv.includes('--dry')

// Board Type → abbreviation used in material code (matches makeShortAbbr in the API).
const BOARD_TYPES: Array<{ value: string; abbreviation: string; sortOrder: number }> = [
  { value: 'Saffire', abbreviation: 'SAFF', sortOrder: 10 },
  { value: 'FBB', abbreviation: 'FBB', sortOrder: 20 },
  { value: 'Duplex GB', abbreviation: 'DPGB', sortOrder: 30 },
  { value: 'Duplex WB', abbreviation: 'DPWB', sortOrder: 40 },
  { value: 'Paper', abbreviation: 'PAPR', sortOrder: 50 },
]

type ExcelRow = Record<string, unknown> // headers in source file have trailing spaces — normalised at read time

type ParsedRow = {
  si: number
  rawProduct: string
  paperType: string
  category: string
  sheetLength: number
  sheetWidth: number
  gsm: number
  sheetsPerPacket: number
  perSheetKg: number
  boardType: string
  attributes: string
  packetWeightKg: number
}

function parseProduct(s: string): { l: number; w: number; gsm: number } | null {
  const m = String(s).trim().toUpperCase().replace(/\s+/g, '').match(/^([\d.]+)X([\d.]+)-(\d+)$/)
  if (!m) return null
  return { l: parseFloat(m[1]), w: parseFloat(m[2]), gsm: parseInt(m[3], 10) }
}

function deriveBoardType(category: string, paperType: string): string {
  const c = category.trim()
  const p = paperType.trim().toUpperCase()
  if (c === 'Duplex' && p === 'GB') return 'Duplex GB'
  if (c === 'Duplex' && p === 'WB') return 'Duplex WB'
  return c // Saffire | FBB | Paper
}

function makeShortAbbr(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return cleaned.slice(0, 4) || 'BRD'
}

function buildMaterialCode(boardType: string, l: number, w: number, gsm: number, abbrMap: Map<string, string>): string {
  const abbrSrc = abbrMap.get(boardType.toLowerCase()) ?? boardType
  const abbr = makeShortAbbr(abbrSrc)
  return `${Math.round(l)}${Math.round(w)}${abbr}${Math.round(gsm)}`
}

function description(boardType: string, gsm: number, attributes: string): string {
  return [boardType, `${gsm} GSM`, attributes].filter(Boolean).join(' · ')
}

async function ensureBoardTypeMiniMaster(): Promise<Map<string, string>> {
  const cat = await db.effectCategory.upsert({
    where: { name: 'Board Type' },
    update: { active: true },
    create: { name: 'Board Type', active: true, sortOrder: 10 },
  })
  for (const bt of BOARD_TYPES) {
    await db.effectValue.upsert({
      where: { categoryId_value: { categoryId: cat.id, value: bt.value } },
      update: { abbreviation: bt.abbreviation, active: true, sortOrder: bt.sortOrder },
      create: {
        categoryId: cat.id,
        value: bt.value,
        abbreviation: bt.abbreviation,
        sortOrder: bt.sortOrder,
        active: true,
      },
    })
  }
  // Map: board type (lowercased) → abbreviation
  const all = await db.effectValue.findMany({
    where: { categoryId: cat.id, active: true },
    select: { value: true, abbreviation: true },
  })
  return new Map(all.map((e) => [e.value.toLowerCase(), e.abbreviation || e.value]))
}

function normaliseKeys(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) out[k.trim()] = v
  return out
}

function parseRows(): { rows: ParsedRow[]; skipped: Array<{ si: number; reason: string; data: ExcelRow }> } {
  const wb = XLSX.readFile(EXCEL_PATH)
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json<ExcelRow>(ws, { defval: null }).map(normaliseKeys)

  const rows: ParsedRow[] = []
  const skipped: Array<{ si: number; reason: string; data: ExcelRow }> = []

  for (const r of raw) {
    const product = String(r['Product- Gsm'] ?? '').trim()
    const paperType = String(r['Paper Type'] ?? '').trim()
    const category = String(r['Category'] ?? '').trim()
    const spp = Number(r['Per packet qty'])
    const perSheetKg = Number(r['Pkt/Weight'])
    const si = Number(r.Si)

    const dims = parseProduct(product)
    if (!dims || dims.l <= 0 || dims.w <= 0 || dims.gsm <= 0) {
      skipped.push({ si, reason: `unparseable or zero spec: "${product}"`, data: r })
      continue
    }
    if (!Number.isFinite(spp) || spp <= 0) {
      skipped.push({ si, reason: `bad sheets/packet: ${spp}`, data: r })
      continue
    }
    if (!Number.isFinite(perSheetKg) || perSheetKg <= 0) {
      skipped.push({ si, reason: `bad per-sheet weight: ${perSheetKg}`, data: r })
      continue
    }

    const boardType = deriveBoardType(category, paperType)
    rows.push({
      si,
      rawProduct: product,
      paperType,
      category,
      sheetLength: dims.l,
      sheetWidth: dims.w,
      gsm: dims.gsm,
      sheetsPerPacket: spp,
      perSheetKg,
      boardType,
      attributes: paperType,
      packetWeightKg: Number((perSheetKg * spp).toFixed(3)),
    })
  }
  return { rows, skipped }
}

async function main() {
  console.log(`Board Master reseed — DRY_RUN=${DRY_RUN}`)

  const { rows, skipped } = parseRows()
  console.log(`Parsed ${rows.length} valid rows, skipped ${skipped.length}.`)
  if (skipped.length) {
    console.log('Skipped rows:')
    for (const s of skipped) console.log(`  Si=${s.si}  ${s.reason}`)
  }

  // Detect duplicate spec keys after deriving boardType (must be 0 to satisfy unique constraint)
  const keyCount = new Map<string, ParsedRow[]>()
  for (const r of rows) {
    const k = `${r.boardType}|${r.sheetLength}|${r.sheetWidth}|${r.gsm}`
    if (!keyCount.has(k)) keyCount.set(k, [])
    keyCount.get(k)!.push(r)
  }
  const collisions = [...keyCount.entries()].filter(([, v]) => v.length > 1)
  let deduped = rows
  if (collisions.length) {
    console.warn(`! ${collisions.length} duplicate spec keys after split — keeping first occurrence of each:`)
    for (const [k, v] of collisions) {
      console.warn(`  ${k} -> Si=[${v.map((x) => x.si).join(', ')}]  (kept Si=${v[0].si})`)
    }
    const seen = new Set<string>()
    deduped = rows.filter((r) => {
      const k = `${r.boardType}|${r.sheetLength}|${r.sheetWidth}|${r.gsm}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    console.log(`Deduped: ${rows.length} -> ${deduped.length}`)
  } else {
    console.log('✓ No duplicate (boardType, length, width, gsm) keys.')
  }
  rows.length = 0
  rows.push(...deduped)

  // Sanity-check: weights re-derive from formula within tolerance
  let weightWarnings = 0
  for (const r of rows) {
    const expected = (r.sheetLength * r.sheetWidth * r.gsm) / 1_550_000
    const ratio = r.perSheetKg / expected
    if (ratio < 0.95 || ratio > 1.05) {
      console.warn(`  ! Si=${r.si} ${r.rawProduct} per-sheet weight ${r.perSheetKg} differs from formula ${expected.toFixed(4)} (ratio ${ratio.toFixed(3)})`)
      weightWarnings++
    }
  }
  console.log(`Weight check: ${rows.length - weightWarnings}/${rows.length} within 5% of formula.`)

  // Tally by boardType
  const tally = new Map<string, number>()
  for (const r of rows) tally.set(r.boardType, (tally.get(r.boardType) ?? 0) + 1)
  console.log('Rows per boardType:')
  for (const [k, v] of [...tally.entries()].sort()) console.log(`  ${k}: ${v}`)

  if (DRY_RUN) {
    console.log('\nDRY RUN — no DB writes performed.')
    return
  }

  // 1. Seed Mini Master Board Types
  console.log('\nSeeding Board Type mini master...')
  const abbrMap = await ensureBoardTypeMiniMaster()
  console.log(`✓ Board Type entries upserted (${abbrMap.size}).`)

  // 2. Wipe inventory (audited)
  const existing = await db.inventory.count()
  console.log(`\nDeleting ${existing} existing inventory rows...`)
  const del = await db.inventory.deleteMany({})
  console.log(`✓ Deleted ${del.count} rows.`)

  // 3. Insert new rows. Use createMany with code disambiguation in a single pass.
  const codeSeen = new Set<string>()
  const records: Prisma.InventoryCreateManyInput[] = rows.map((r) => {
    let code = buildMaterialCode(r.boardType, r.sheetLength, r.sheetWidth, r.gsm, abbrMap)
    let n = 0
    while (codeSeen.has(code)) {
      n++
      code = `${buildMaterialCode(r.boardType, r.sheetLength, r.sheetWidth, r.gsm, abbrMap)}-${n}`
    }
    codeSeen.add(code)
    return {
      materialCode: code,
      description: description(r.boardType, r.gsm, r.attributes),
      boardType: r.boardType,
      boardClassification: r.boardType,
      sheetLength: new Prisma.Decimal(r.sheetLength),
      sheetWidth: new Prisma.Decimal(r.sheetWidth),
      gsm: r.gsm,
      attributes: r.attributes,
      unit: 'packets',
      packetWeight: new Prisma.Decimal(r.packetWeightKg),
      sheetsPerPacket: new Prisma.Decimal(r.sheetsPerPacket),
      reorderPoint: new Prisma.Decimal(0),
      safetyStock: new Prisma.Decimal(0),
      leadTimeDays: 7,
      weightedAvgCost: new Prisma.Decimal(0),
      qtyAvailable: new Prisma.Decimal(0),
      qtyReserved: new Prisma.Decimal(0),
      qtyQuarantine: new Prisma.Decimal(0),
      qtyFg: new Prisma.Decimal(0),
      physicalStockSheets: new Prisma.Decimal(0),
      shortageSheets: new Prisma.Decimal(0),
      totalWeightKg: new Prisma.Decimal(0),
      active: true,
    }
  })

  console.log(`\nInserting ${records.length} inventory rows...`)
  const ins = await db.inventory.createMany({ data: records, skipDuplicates: false })
  console.log(`✓ Inserted ${ins.count} rows.`)

  // 4. Final verification
  const finalCount = await db.inventory.count()
  const byType = await db.inventory.groupBy({ by: ['boardType'], _count: true })
  console.log(`\nFinal inventory count: ${finalCount}`)
  console.log('By boardType:')
  for (const g of byType.sort((a, b) => (a.boardType ?? '').localeCompare(b.boardType ?? ''))) {
    console.log(`  ${g.boardType}: ${g._count}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
