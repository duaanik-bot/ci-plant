/**
 * backfill-legacy-rate-board.ts — fixes the legacy-recovered cartons:
 *   • rate: legacy cartons.csv rate is empty; pull the LATEST price
 *     (most recent created_at) from carton_prices.csv (qty-tiered).
 *   • boardGrade: recompute via canonicalBoardGrade using the legacy
 *     paper_type_id → label map (only known ids; unknown stay null/blank).
 *
 * Only touches source='legacy_recovery'. Sheet size / UPS / printing are
 * intentionally left blank (absent from the legacy export).
 *
 * USAGE:
 *   npx tsx scripts/backfill-legacy-rate-board.ts            # dry-run
 *   npx tsx scripts/backfill-legacy-rate-board.ts --confirm  # apply
 */
import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'
import { canonicalBoardGrade } from '../src/lib/carton/canonical'

const prisma = new PrismaClient()
const CONFIRM = process.argv.includes('--confirm')

const PAPER_TYPE: Record<number, string> = {
  1: 'FBB',
  2: 'SBS',
  3: 'GD2 Grey Back',
  4: 'Kraft',
  7: 'Art Card',
}

function p(line: string): string[] {
  const o: string[] = []
  let c = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        c += '"'
        i++
      } else if (ch === '"') q = false
      else c += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      o.push(c)
      c = ''
    } else c += ch
  }
  o.push(c)
  return o
}
const rd = (f: string) =>
  fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map(p)

async function main() {
  // company_name(UPPER) -> legacy client_id
  const clientByName = new Map<string, string>()
  for (const c of rd('data/legacy-csv/clients.csv'))
    if (c[0] && c[4]) clientByName.set(c[4].trim().toUpperCase(), c[0].trim())

  // legacy carton: (clientId|NAME) -> { ids:Set, paperId }
  const legacyCarton = new Map<string, { ids: Set<string>; paperId: number | null }>()
  for (const c of rd('data/legacy-csv/cartons.csv')) {
    const key = `${c[1]}|${(c[2] ?? '').trim().toUpperCase()}`
    const e = legacyCarton.get(key) ?? { ids: new Set<string>(), paperId: null }
    e.ids.add(c[0])
    const pid = c[8] ? Number(c[8]) : null
    if (e.paperId == null && pid != null) e.paperId = pid
    legacyCarton.set(key, e)
  }

  // legacy carton_id -> latest price (max created_at, tiebreak max row id)
  const latestPrice = new Map<string, { price: number; created: string; rowId: number }>()
  for (const r of rd('data/legacy-csv/carton_prices.csv')) {
    const cid = r[1]
    const price = Number(r[3])
    const created = r[4] ?? ''
    const rowId = Number(r[0])
    if (!Number.isFinite(price)) continue
    const cur = latestPrice.get(cid)
    if (
      !cur ||
      created > cur.created ||
      (created === cur.created && rowId > cur.rowId)
    )
      latestPrice.set(cid, { price, created, rowId })
  }

  const cartons = await prisma.carton.findMany({
    where: { source: 'legacy_recovery' },
    select: {
      id: true,
      cartonName: true,
      rate: true,
      boardGrade: true,
      customer: { select: { name: true } },
    },
  })

  let rateFix = 0
  let boardFix = 0
  let unmatched = 0
  const updates: { id: string; data: Record<string, unknown> }[] = []

  for (const c of cartons) {
    const clientId = clientByName.get(c.customer.name.trim().toUpperCase())
    if (!clientId) {
      unmatched++
      continue
    }
    const lk = `${clientId}|${c.cartonName.trim().toUpperCase()}`
    const leg = legacyCarton.get(lk)
    if (!leg) {
      unmatched++
      continue
    }
    let best: { price: number; created: string; rowId: number } | null = null
    for (const lid of leg.ids) {
      const pr = latestPrice.get(lid)
      if (
        pr &&
        (!best ||
          pr.created > best.created ||
          (pr.created === best.created && pr.rowId > best.rowId))
      )
        best = pr
    }
    const newBoard = canonicalBoardGrade(
      leg.paperId != null ? PAPER_TYPE[leg.paperId] ?? null : null,
    )
    const data: Record<string, unknown> = {}
    if (best && c.rate == null) {
      data.rate = best.price
      rateFix++
    }
    if (newBoard && newBoard !== c.boardGrade) {
      data.boardGrade = newBoard
      boardFix++
    }
    if (Object.keys(data).length) updates.push({ id: c.id, data })
  }

  console.log('── Legacy rate/board backfill ──')
  console.table({
    legacyRecoveryCartons: cartons.length,
    rateToFill: rateFix,
    boardToFix: boardFix,
    unmatchedToLegacy: unmatched,
    mode: CONFIRM ? 'WRITE' : 'DRY-RUN',
  })
  console.log(
    'sample:',
    JSON.stringify(updates.slice(0, 5)),
  )

  if (!CONFIRM) {
    console.log('\nDRY-RUN — nothing written. Add --confirm to apply.')
    return
  }
  for (let i = 0; i < updates.length; i += 200) {
    const batch = updates.slice(i, i + 200)
    await prisma.$transaction(
      batch.map((u) => prisma.carton.update({ where: { id: u.id }, data: u.data })),
    )
  }
  console.log(`✅ Backfilled ${updates.length} carton(s) (rate:${rateFix}, board:${boardFix}).`)
}

main()
  .catch((e) => {
    console.error('Backfill failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
