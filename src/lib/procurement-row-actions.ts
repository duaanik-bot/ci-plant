/**
 * Pure helpers for warehouse row-level procurement decisions.
 * Keeps the "which PR flow / is this row bulk-eligible" logic out of the page
 * component so it can be unit-tested in isolation.
 */

export type RowProcurementShape = {
  shortage_sheets: number
  open_pr_id?: string | null
}

/**
 * Which create-PR flow a single row should use when the user picks "Raise PR".
 * - 'shortage': the row has an open shortage and no PR yet → create from the
 *   shortage record (qty pre-filled from pending shortage).
 * - 'manual': no open shortage to anchor on → operator types the qty.
 */
export function prModeForRow(row: RowProcurementShape): 'shortage' | 'manual' {
  if (Number(row.shortage_sheets) > 0 && !row.open_pr_id) return 'shortage'
  return 'manual'
}

/**
 * Whether a row should be included when raising PRs in bulk. Only rows that
 * have an open shortage and do not already have a PR are actioned; everything
 * else is skipped (and surfaced in the summary toast).
 */
export function eligibleForBulkPr(row: RowProcurementShape): boolean {
  return Number(row.shortage_sheets) > 0 && !row.open_pr_id
}
