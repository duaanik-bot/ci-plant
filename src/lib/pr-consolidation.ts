export type ConsolidatablePr = {
  id: string
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
  qty: number
  supplierId: string | null
  requiredByDate: string | null
}

export type ConsolidatedGroupMember = {
  prId: string
  qty: number
  supplierId: string | null
  requiredByDate: string | null
}

export type ConsolidatedGroup = {
  key: string
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
  totalQty: number
  members: ConsolidatedGroupMember[]
  suggestedSupplierId: string | null
  earliestRequiredDate: string | null
}

export function consolidationKey(pr: {
  materialId: string
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
}): string {
  return JSON.stringify([pr.materialId, pr.boardType, pr.gsm, pr.sizeLabel])
}

function mostCommonSupplier(members: ConsolidatedGroupMember[]): string | null {
  const counts = new Map<string, number>()
  for (const m of members) {
    if (!m.supplierId) continue
    counts.set(m.supplierId, (counts.get(m.supplierId) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [supplierId, count] of counts) {
    if (count > bestCount) {
      best = supplierId
      bestCount = count
    }
  }
  return best
}

function earliestDate(members: ConsolidatedGroupMember[]): string | null {
  const dates = members.map((m) => m.requiredByDate).filter((d): d is string => !!d)
  if (dates.length === 0) return null
  return dates.reduce((a, b) => (new Date(a).getTime() <= new Date(b).getTime() ? a : b))
}

export function consolidatePrs(prs: ConsolidatablePr[]): ConsolidatedGroup[] {
  const byKey = new Map<string, ConsolidatedGroup>()

  for (const pr of prs) {
    const key = consolidationKey(pr)
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        materialId: pr.materialId,
        materialCode: pr.materialCode,
        boardType: pr.boardType,
        gsm: pr.gsm,
        sizeLabel: pr.sizeLabel,
        totalQty: 0,
        members: [],
        suggestedSupplierId: null,
        earliestRequiredDate: null,
      }
      byKey.set(key, group)
    }
    group.totalQty += pr.qty
    group.members.push({
      prId: pr.id,
      qty: pr.qty,
      supplierId: pr.supplierId,
      requiredByDate: pr.requiredByDate,
    })
  }

  const groups = Array.from(byKey.values())
  for (const group of groups) {
    group.suggestedSupplierId = mostCommonSupplier(group.members)
    group.earliestRequiredDate = earliestDate(group.members)
  }
  return groups
}
