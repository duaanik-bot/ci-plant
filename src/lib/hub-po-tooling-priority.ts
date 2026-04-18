import type { PrismaClient } from '@prisma/client'

export type PriorityLine = {
  cartonId: string | null
  cartonName: string
  poCustomerId: string
  customerName: string
}

/** Load PO lines that are director / PO priority for tooling cross-module sync. */
export async function loadPriorityPoLineContext(db: PrismaClient): Promise<PriorityLine[]> {
  const rows = await db.poLineItem.findMany({
    where: {
      OR: [{ directorPriority: true }, { po: { isPriority: true } }],
    },
    select: {
      cartonId: true,
      cartonName: true,
      po: { select: { customerId: true, customer: { select: { name: true } } } },
    },
  })
  return rows.map((r) => ({
    cartonId: r.cartonId,
    cartonName: r.cartonName,
    poCustomerId: r.po.customerId,
    customerName: r.po.customer?.name ?? '',
  }))
}

export function poLineMatchesEmbossBlock(
  lines: PriorityLine[],
  block: {
    id: string
    customerId: string | null
    cartonName: string | null
    cartonIds: string[]
    cartonNames: string[]
  },
): boolean {
  const names = new Set(
    [block.cartonName, ...block.cartonNames].map((n) => n?.trim().toLowerCase()).filter(Boolean) as string[],
  )
  const cartonIdSet = new Set(block.cartonIds)
  return lines.some((l) => {
    if (l.cartonId && cartonIdSet.has(l.cartonId)) return true
    const cn = l.cartonName?.trim().toLowerCase()
    if (cn && names.has(cn)) return true
    if (block.customerId && l.poCustomerId === block.customerId) return true
    return false
  })
}

export function poLineMatchesShadeCard(
  lines: PriorityLine[],
  card: {
    customerId: string | null
    productMaster: string | null
    inkComponent: string | null
  },
): boolean {
  const pm = card.productMaster?.trim().toLowerCase()
  const ink = card.inkComponent?.trim().toLowerCase()
  return lines.some((l) => {
    if (card.customerId && l.poCustomerId === card.customerId) return true
    const lineName = l.cartonName?.trim().toLowerCase()
    const custN = l.customerName?.trim().toLowerCase()
    if (pm && lineName && (lineName.includes(pm) || pm.includes(lineName))) return true
    if (pm && custN && (custN.includes(pm) || pm.split(/\s+/).some((w) => w.length > 2 && custN.includes(w))))
      return true
    if (ink && lineName && lineName.includes(ink)) return true
    return false
  })
}

/** Fuzzy token match for shade / emboss hub search (e.g. "Swiss" → Swiss Garnier). */
export function rowMatchesSearchTokens(
  tokens: string[],
  haystackParts: (string | null | undefined)[],
): boolean {
  if (tokens.length === 0) return true
  const hay = haystackParts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return tokens.every((t) => hay.includes(t.toLowerCase()))
}
