/**
 * update-carton-effects.ts — updates Embossing / Leafing on existing carton
 * masters from the "carton_effects_data.xlsx" sheet.
 *
 * USAGE:
 *   npx tsx scripts/update-carton-effects.ts "<path.xlsx>"            # dry-run
 *   npx tsx scripts/update-carton-effects.ts "<path.xlsx>" --confirm  # apply
 *
 * No UI/UX changes. For each matched carton it sets:
 *   - embossingLeafing  → 'Embossing + Leafing' | 'Embossing' | 'Leafing'
 *   - specialInstructions JSON → embossingEnabled / leafingEnabled flags
 *     (notes / brailleEnabled / spotUvEnabled preserved)
 * so the Carton Master form checkboxes reflect the new state.
 *
 * Sheet: "Carton Effects". Row 0 title, row 1 subtitle, row 2 header,
 * data from row 3. Columns: 0 Carton  1 Customer  3 Embossing  4 Leafing
 */
import { PrismaClient } from '@prisma/client'
import * as XLSX from 'xlsx'

const db = new PrismaClient()

const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
const isCheck = (v: unknown) => {
  const s = String(v ?? '').trim()
  return s === '✓' || s.toUpperCase() === 'YES' || s.toUpperCase() === 'TRUE'
}

function mergeSpecialInstructions(raw: string | null, emb: boolean, leaf: boolean): string {
  let base: Record<string, unknown> = {
    notes: '',
    brailleEnabled: false,
    leafingEnabled: false,
    embossingEnabled: false,
    spotUvEnabled: false,
  }
  if (raw) {
    try {
      const o = JSON.parse(raw)
      if (o && typeof o === 'object') base = { ...base, ...o }
      else base.notes = String(raw)
    } catch {
      base.notes = raw
    }
  }
  base.embossingEnabled = emb
  base.leafingEnabled = leaf
  return JSON.stringify(base)
}

async function main() {
  const file = process.argv[2]
  const confirm = process.argv.includes('--confirm')
  if (!file) {
    console.error('Provide path to xlsx')
    process.exit(1)
  }

  const wb = XLSX.readFile(file)
  const ws = wb.Sheets['Carton Effects'] ?? wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false })
  const data = rows.slice(3).filter((r) => r && String(r[0] ?? '').trim())

  console.log(`Read ${data.length} effect rows from "${file}"`)
  console.log(confirm ? '*** CONFIRM MODE — writes will be applied ***\n' : '*** DRY RUN — no writes ***\n')

  // Preload customers + cartons
  const customers = await db.customer.findMany({ select: { id: true, name: true } })
  const custByName = new Map<string, { id: string; name: string }[]>()
  for (const c of customers) {
    const k = norm(c.name)
    if (!custByName.has(k)) custByName.set(k, [])
    custByName.get(k)!.push(c)
  }

  let matched = 0
  let updated = 0
  const noCustomer: string[] = []
  const noCarton: string[] = []
  const ambiguous: string[] = []
  const sample: string[] = []

  for (const r of data) {
    const cartonName = String(r[0]).trim()
    const customerName = String(r[1] ?? '').trim()
    const emb = isCheck(r[3])
    const leaf = isCheck(r[4])
    if (!emb && !leaf) continue

    const custs = custByName.get(norm(customerName)) ?? []
    if (custs.length === 0) {
      noCustomer.push(`${customerName} :: ${cartonName}`)
      continue
    }

    const cartons = await db.carton.findMany({
      where: {
        customerId: { in: custs.map((c) => c.id) },
        cartonName: { equals: cartonName, mode: 'insensitive' },
      },
      select: { id: true, cartonName: true, embossingLeafing: true, specialInstructions: true },
    })

    if (cartons.length === 0) {
      noCarton.push(`${customerName} :: ${cartonName}`)
      continue
    }
    if (cartons.length > 1) {
      ambiguous.push(`${customerName} :: ${cartonName} (${cartons.length} matches)`)
    }

    const embossingLeafing =
      emb && leaf ? 'Embossing + Leafing' : emb ? 'Embossing' : 'Leafing'

    for (const ct of cartons) {
      matched++
      const newSI = mergeSpecialInstructions(ct.specialInstructions, emb, leaf)
      if (sample.length < 15) {
        sample.push(
          `  ${ct.cartonName}  [${ct.embossingLeafing ?? '—'}] -> [${embossingLeafing}]`,
        )
      }
      if (confirm) {
        await db.carton.update({
          where: { id: ct.id },
          data: { embossingLeafing, specialInstructions: newSI },
        })
        updated++
      }
    }
  }

  console.log('Sample changes:')
  console.log(sample.join('\n'))
  console.log('\n──────── SUMMARY ────────')
  console.log(`Effect rows processed : ${data.length}`)
  console.log(`Carton masters matched: ${matched}`)
  console.log(`Updated (written)     : ${confirm ? updated : 0}`)
  console.log(`Customer not found    : ${noCustomer.length}`)
  console.log(`Carton not found      : ${noCarton.length}`)
  console.log(`Ambiguous (multi)     : ${ambiguous.length}`)
  if (noCustomer.length)
    console.log('\n-- Customer not found --\n' + noCustomer.join('\n'))
  if (noCarton.length) console.log('\n-- Carton not found --\n' + noCarton.join('\n'))
  if (ambiguous.length) console.log('\n-- Ambiguous --\n' + ambiguous.join('\n'))

  await db.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await db.$disconnect()
  process.exit(1)
})
