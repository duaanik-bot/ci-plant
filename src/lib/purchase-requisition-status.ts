export type PrUiStage = 'draft' | 'approved' | 'ordered' | 'received'
export type PrDbStatus = 'pending' | 'approved' | 'converted_to_po' | 'received' | 'rejected'

export const PR_STAGE_LABEL: Record<PrUiStage, string> = {
  draft: 'Draft',
  approved: 'Approved',
  ordered: 'Ordered',
  received: 'Received',
}

export function dbStatusToUiStage(status: string | null | undefined): PrUiStage {
  if (status === 'approved') return 'approved'
  if (status === 'converted_to_po') return 'ordered'
  if (status === 'received') return 'received'
  return 'draft'
}

export function uiStageToDbStatus(stage: PrUiStage): PrDbStatus {
  if (stage === 'approved') return 'approved'
  if (stage === 'ordered') return 'converted_to_po'
  if (stage === 'received') return 'received'
  return 'pending'
}

export function mapFilterToDbStatuses(input: string | null | undefined): string[] | null {
  const val = (input || '').trim().toLowerCase()
  if (!val) return null
  if (val === 'draft' || val === 'pending') return ['pending']
  if (val === 'approved') return ['approved']
  if (val === 'ordered' || val === 'converted_to_po') return ['converted_to_po']
  if (val === 'received') return ['received']
  if (val === 'rejected') return ['rejected']
  return null
}
