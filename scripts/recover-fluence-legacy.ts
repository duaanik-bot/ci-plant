/**
 * recover-fluence-legacy.ts — backfills Fluence Pharma cartons that exist in
 * the legacy export (data/legacy-csv/cartons.csv, client_id=3) but are NOT in
 * the Carton Master Bible (which only carried 29 of them).
 *
 * Only inserts legacy Fluence cartons whose name is not already present for
 * the Fluence customer. Tagged source='legacy_recovery'. Legacy data is
 * lower-fidelity: no UPS / sheet size / category / pasting style; board &
 * coating are id-coded (mapped via the legacy id tables, then run through the
 * same canonical vocab as the Bible import).
 *
 * USAGE:
 *   npx tsx scripts/recover-fluence-legacy.ts            # dry-run
 *   npx tsx scripts/recover-fluence-legacy.ts --confirm  # apply
 */
import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'
import { parseDims, parseRate, parseGsm } from '../src/lib/carton/parse'
import { canonicalBoardGrade, canonicalCoating } from '../src/lib/carton/canonical'

const prisma = new PrismaClient()
const CONFIRM = process.argv.includes('--confirm')
const LEGACY_CSV = 'data/legacy-csv/cartons.csv'
const FLUENCE_CLIENT_ID = '3'

// Legacy id → label maps (from scripts/migrate-from-legacy.ts).
const PAPER_TYPE: Record<number, string> = {
  1: 'FBB',
  2: 'SBS',
  3: 'GD2 Grey Back',
  4: 'Kraft',
  7: 'Art Card',
}
const COATING_TYPE: Record<number, string> = {
  1: 'Matt',
  2: 'Gloss',
  3: 'Matt Lamination',
  4: 'Gloss Lamination',
  5: 'Soft Touch',
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

async function main() {
  if (!fs.existsSync(LEGACY_CSV)) {
    console.error('Missing', LEGACY_CSV)
    process.exit(1)
  }
  const customer = await prisma.customer.findFirst({
    where: { name: { contains: 'FLUENCE', mode: 'insensitive' } },
    select: { id: true, name: true },
  })
  if (!customer) {
    console.error('No Fluence customer found in DB')
    process.exit(1)
  }
  const existing = new Set(
    (
      await prisma.carton.findMany({
        where: { customerId: customer.id },
        select: { cartonName: true },
      })
    ).map((c) => c.cartonName.trim().toUpperCase()),
  )

  const lines = fs.readFileSync(LEGACY_CSV, 'utf8').split(/\r?\n/).slice(1).filter(Boolean)
  const seen = new Set<string>()
  const toInsert: {
    cartonName: string
    finishedLength: number | null
    finishedWidth: number | null
    finishedHeight: number | null
    rate: number | null
    gsm: number | null
    boardGrade: string | null
    coatingType: string | null
    embossingLeafing: string | null
    artworkCode: string | null
  }[] = []

  for (const line of lines) {
    const c = parseCsvLine(line)
    if (c[1] !== FLUENCE_CLIENT_ID) continue
    const name = (c[2] ?? '').trim()
    if (!name) continue
    const key = name.toUpperCase()
    if (existing.has(key) || seen.has(key)) continue // already in DB or dup in legacy
    seen.add(key)
    const dims = parseDims(c[3])
    const paperId = c[8] ? Number(c[8]) : null
    const coatId = c[5] ? Number(c[5]) : null
    toInsert.push({
      cartonName: name,
      finishedLength: dims.l,
      finishedWidth: dims.w,
      finishedHeight: dims.h,
      rate: parseRate(c[4]),
      gsm: parseGsm(c[9]),
      boardGrade: canonicalBoardGrade(paperId ? PAPER_TYPE[paperId] ?? null : null),
      coatingType: canonicalCoating(coatId ? COATING_TYPE[coatId] ?? null : null),
      embossingLeafing: (c[7] ?? '').trim() || null,
      artworkCode: (c[10] ?? '').trim() || null,
    })
  }

  console.log('── Fluence legacy recovery ──')
  console.table({
    customer: customer.name,
    alreadyInDb: existing.size,
    legacyMissingToInsert: toInsert.length,
    mode: CONFIRM ? 'WRITE' : 'DRY-RUN',
  })
  console.log(
    'sample:',
    JSON.stringify(toInsert.slice(0, 5).map((x) => x.cartonName)),
  )

  if (!CONFIRM) {
    console.log('\nDRY-RUN — nothing written. Add --confirm to insert.')
    return
  }

  for (let i = 0; i < toInsert.length; i += 100) {
    const batch = toInsert.slice(i, i + 100)
    await prisma.$transaction(
      batch.map((rec) =>
        prisma.carton.create({
          data: { ...rec, customerId: customer.id, source: 'legacy_recovery' },
        }),
      ),
    )
  }
  console.log(`✅ Recovered ${toInsert.length} Fluence carton(s).`)
}

main()
  .catch((e) => {
    console.error('Recovery failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
