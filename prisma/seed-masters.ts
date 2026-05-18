import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

type Seed = {
  code: string
  name: string
  sortOrder: number
  values: { code: string; value: string; sortOrder: number }[]
}

const CATEGORIES: Seed[] = [
  {
    code: 'UNIT', name: 'Unit', sortOrder: 10,
    values: [
      { code: 'NOS', value: 'Numbers', sortOrder: 10 },
      { code: 'KG', value: 'Kilogram', sortOrder: 20 },
      { code: 'SHT', value: 'Sheets', sortOrder: 30 },
      { code: 'BOX', value: 'Box', sortOrder: 40 },
      { code: 'GRS', value: 'Gross', sortOrder: 50 },
      { code: 'TON', value: 'Tonnes', sortOrder: 60 },
      { code: 'MTR', value: 'Metres', sortOrder: 70 },
      { code: 'LTR', value: 'Litres', sortOrder: 80 },
      { code: 'PKT', value: 'Packets', sortOrder: 90 },
    ],
  },
  {
    code: 'BOARD_TYPE', name: 'Board Type', sortOrder: 20,
    values: [
      { code: 'FBB', value: 'FBB', sortOrder: 10 },
      { code: 'SBS', value: 'SBS', sortOrder: 20 },
      { code: 'DGB', value: 'Duplex GB', sortOrder: 30 },
      { code: 'DWB', value: 'Duplex WB', sortOrder: 40 },
      { code: 'KRFT', value: 'Kraft', sortOrder: 50 },
    ],
  },
  {
    code: 'BOARD_COLOUR', name: 'Board Colour', sortOrder: 30,
    values: [
      { code: 'WHT', value: 'White', sortOrder: 10 },
      { code: 'GRY', value: 'Grey-back', sortOrder: 20 },
      { code: 'KRF', value: 'Kraft brown', sortOrder: 30 },
    ],
  },
  { code: 'COATING', name: 'Coating', sortOrder: 40, values: [] },
  { code: 'FOIL', name: 'Foil', sortOrder: 50, values: [] },
  { code: 'EMBOSS', name: 'Emboss', sortOrder: 60, values: [] },
  { code: 'PASTING', name: 'Pasting', sortOrder: 70, values: [] },
]

async function main() {
  for (const c of CATEGORIES) {
    const cat = await db.effectCategory.upsert({
      where: { code: c.code },
      update: { name: c.name, sortOrder: c.sortOrder },
      create: { code: c.code, name: c.name, sortOrder: c.sortOrder, active: true },
    })
    for (const v of c.values) {
      // Reconcile by the human value first: a pre-existing row may have been
      // backfilled with a name-derived code (e.g. DUPLEX_GB) that differs from
      // the canonical seed code (DGB). Align it in place rather than inserting
      // a duplicate that would violate the (categoryId, value) unique.
      const byValue = await db.effectValue.findFirst({
        where: { categoryId: cat.id, value: v.value },
        select: { id: true },
      })
      if (byValue) {
        await db.effectValue.update({
          where: { id: byValue.id },
          data: { code: v.code, sortOrder: v.sortOrder, active: true },
        })
      } else {
        await db.effectValue.upsert({
          where: { categoryId_code: { categoryId: cat.id, code: v.code } },
          update: { value: v.value, sortOrder: v.sortOrder, active: true },
          create: { categoryId: cat.id, code: v.code, value: v.value, sortOrder: v.sortOrder, active: true },
        })
      }
    }
  }
  console.log('Masters seeded.')
}

main().finally(() => db.$disconnect())
