/** Best-effort city line for dropdowns when there is no dedicated city column. */
export function cityFromAddress(address?: string | null): string {
  if (!address) return '—'
  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return '—'
  return parts.length > 1 ? parts[parts.length - 2]! : parts[parts.length - 1]!
}
