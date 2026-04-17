/** Extract `YYYY-MM-DD` from legacy remarks: "Delivery by: YYYY-MM-DD". */
export function parseDeliveryYmdFromRemarks(remarks: string | null | undefined): string | null {
  if (!remarks?.trim()) return null
  const m = remarks.match(/Delivery\s+by:\s*(\d{4}-\d{2}-\d{2})/i)
  return m ? m[1]! : null
}

export function addCalendarDaysYmd(ymd: string, days: number): string | null {
  const [y, mo, d] = ymd.split('-').map((x) => parseInt(x, 10))
  if (!y || !mo || !d) return null
  const dt = new Date(Date.UTC(y, mo - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}
