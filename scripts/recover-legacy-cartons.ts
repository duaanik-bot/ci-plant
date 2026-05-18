/**
 * recover-legacy-cartons.ts — backfills cartons that exist in the legacy
 * export (data/legacy-csv/cartons.csv) but were dropped by the curated
 * Carton Master Bible, for the customers we still serve.
 *
 * IN SCOPE (must have full coverage):
 *   legacy client_id 3 = FLUENCE PHARMA PVT LTD
 *   legacy client_id 4 = SWISS GARNIERS BIOTECH PRIVATE LIMITED
 *   legacy client_id 5 = Swiss Garnier Life Sciences
 *   legacy client_id 6 = GALPHA LABORATORIES LTD
 *
 * EXCLUDED ON PURPOSE:
 *   legacy client_id 7 = VENUS REMEDIES LTD (no longer a customer — dropped)
 *   (clients 1 HERBOVEDA, 2 PURE FLIX not requested — left as Bible-only)
 *
 * Only inserts legacy cartons whose name is not already present for the
 * matched DB customer (so re-runs and the earlier Fluence recovery are
 * idempotent). Tagged source='legacy_recovery'. Legacy data is lower
 * fidelity: no UPS / sheet size / category / pasting style; board & coating
 * are id-coded then run through the same canonical vocab as the Bible import.
 *
 * USAGE:
 *   npx tsx scripts/recover-legacy-cartons.ts            # dry-run
 *   npx tsx scripts/recover-legacy-cartons.ts --confirm  # apply
 */
import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'
import { parseDims, parseRate, parseGsm } from '../src/lib/carton/parse'
import { canonicalBoardGrade, canonicalCoating } from '../src/lib/carton/canonical'

const prisma = new PrismaClient()
const CONFIRM = process.argv.includes('--confirm')
const CARTONS_CSV = 'data/legacy-csv/cartons.csv'
const CLIENTS_CSV = 'data/legacy-csv/clients.csv'
const TARGET_CLIENT_IDS = ['3', '4', '5', '6'] // Venus (7) deliberately excluded

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
  for (const f of [CARTONS_CSV, CLIENTS_CSV]) {
    if (!fs.existsSync(f)) {
      console.error('Missing', f)
      process.exit(1)
    }
  }

  // legacy client_id -> company_name
  const clientName = new Map<string, string>()
  for (const ln of fs
    .readFileSync(CLIENTS_CSV, 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)) {
    const c = parseCsvLine(ln)
    if (c[0] && c[4]) clientName.set(c[0].trim(), c[4].trim())
  }

  // resolve each target legacy client to a DB customer (exact, case-insensitive)
  const dbCustomer = new Map<string, { id: string; name: string }>()
  for (const cid of TARGET_CLIENT_IDS) {
    const nm = clientName.get(cid)
    if (!nm) {
      console.warn(`legacy client ${cid} not in clients.csv — skipped`)
      continue
    }
    const cust = await prisma.customer.findFirst({
      where: { name: { equals: nm, mode: 'insensitive' } },
      select: { id: true, name: true },
    })
    if (!cust) {
      console.warn(`DB customer not found for "${nm}" (legacy ${cid}) — skipped`)
      continue
    }
    dbCustomer.set(cid, cust)
  }

  // existing carton names per target customer (skip set)
  const existing = new Map<string, Set<string>>()
  for (const [cid, cust] of dbCustomer) {
    const names = (
      await prisma.carton.findMany({
        where: { customerId: cust.id },
        select: { cartonName: true },
      })
    ).map((c) => c.cartonName.trim().toUpperCase())
    existing.set(cid, new Set(names))
  }

  const lines = fs
    .readFileSync(CARTONS_CSV, 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
  const seenByClient = new Map<string, Set<string>>()
  const toInsert: { customerId: string; data: Record<string, unknown> }[] = []
  const perClient: Record<string, number> = {}

  for (const ln of lines) {
    const c = parseCsvLine(ln)
    const cid = c[1]
    if (!TARGET_CLIENT_IDS.includes(cid) || !dbCustomer.has(cid)) continue
    const name = (c[2] ?? '').trim()
    if (!name) continue
    const key = name.toUpperCase()
    if (!seenByClient.has(cid)) seenByClient.set(cid, new Set())
    if (existing.get(cid)!.has(key) || seenByClient.get(cid)!.has(key)) continue
    seenByClient.get(cid)!.add(key)

    const dims = parseDims(c[3])
    const paperId = c[8] ? Number(c[8]) : null
    const coatId = c[5] ? Number(c[5]) : null
    toInsert.push({
      customerId: dbCustomer.get(cid)!.id,
      data: {
        cartonName: name,
        finishedLength: dims.l,
        finishedWidth: dims.w,
        finishedHeight: dims.h,
        rate: parseRate(c[4]),
        gsm: parseGsm(c[9]),
        boardGrade: canonicalBoardGrade(
          paperId ? PAPER_TYPE[paperId] ?? null : null,
        ),
        coatingType: canonicalCoating(
          coatId ? COATING_TYPE[coatId] ?? null : null,
        ),
        embossingLeafing: (c[7] ?? '').trim() || null,
        artworkCode: (c[10] ?? '').trim() || null,
      },
    })
    const lbl = dbCustomer.get(cid)!.name
    perClient[lbl] = (perClient[lbl] ?? 0) + 1
  }

  console.log('── Legacy carton recovery ──')
  console.table(perClient)
  console.table({
    totalToInsert: toInsert.length,
    mode: CONFIRM ? 'WRITE' : 'DRY-RUN',
  })

  if (!CONFIRM) {
    console.log('\nDRY-RUN — nothing written. Add --confirm to insert.')
    return
  }

  for (let i = 0; i < toInsert.length; i += 100) {
    const batch = toInsert.slice(i, i + 100)
    await prisma.$transaction(
      batch.map((r) =>
        prisma.carton.create({
          data: { ...r.data, customerId: r.customerId, source: 'legacy_recovery' },
        }),
      ),
    )
  }
  console.log(`✅ Recovered ${toInsert.length} carton(s) across target customers.`)
}

main()
  .catch((e) => {
    console.error('Recovery failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
