/** Token-style fuzzy match: all whitespace-separated tokens must appear as substrings (for line / carton names). */
export function lineItemMatchesDrawerQuery(cartonName: string, queryRaw: string): boolean {
  const trimmed = queryRaw.trim()
  if (trimmed.length < 2) return false
  const hay = cartonName.toLowerCase()
  const q = trimmed.toLowerCase()
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  if (tokens.length === 1) return hay.includes(q)
  return tokens.every((t) => hay.includes(t))
}

type PoDeepFilterShape = {
  poNumber: string
  customer: { name?: string | null }
  lineItems: { cartonName: string }[]
}

/** PO list deep filter: PO #, customer name, or any line product name (fuzzy tokens on lines). */
export function purchaseOrdersMatchingDeepQuery<T extends PoDeepFilterShape>(
  orders: T[],
  queryRaw: string,
): T[] {
  const q = queryRaw.trim().toLowerCase()
  if (q.length < 2) return orders
  return orders.filter((p) => {
    if (p.poNumber.toLowerCase().includes(q)) return true
    if ((p.customer?.name ?? '').toLowerCase().includes(q)) return true
    if (p.lineItems.some((li) => lineItemMatchesDrawerQuery(li.cartonName, queryRaw))) return true
    return false
  })
}
