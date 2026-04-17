/** Human-facing die / pasting label from Die Master (prefers detailed `pastingType` when set). */
export function masterDieTypeLabel(d: {
  dyeType: string
  pastingType?: string | null
}): string {
  const p = d.pastingType?.trim()
  if (p) return p
  return d.dyeType?.trim() || '—'
}

export function normalizeDieTypeKey(s: string | null | undefined): string {
  return (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}
