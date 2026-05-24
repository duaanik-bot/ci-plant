export type ProcurementRag = 'green' | 'amber' | 'red'

export function computeRag(row: {
  shortage_sheets: number
  open_pr_id: string | null
  open_pr_status: string | null
  hasOpenPo: boolean
}): ProcurementRag {
  if (row.shortage_sheets <= 0) return 'green'
  if (row.hasOpenPo) return 'amber'
  if (row.open_pr_id && row.open_pr_status !== 'received') return 'amber'
  return 'red'
}

/** Tailwind border class for the left-border row indicator. */
export function ragBorderClass(rag: ProcurementRag): string {
  if (rag === 'green') return 'border-l-2 border-ds-success'
  if (rag === 'amber') return 'border-l-2 border-ds-warning'
  return 'border-l-2 border-ds-error'
}

/** Tailwind background class for the status dot. */
export function ragDotClass(rag: ProcurementRag): string {
  if (rag === 'green') return 'bg-ds-success'
  if (rag === 'amber') return 'bg-ds-warning'
  return 'bg-ds-error'
}
