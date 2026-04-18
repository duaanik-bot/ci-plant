/** Cross-module sync when PO / line priority changes (Customer PO star or director line priority). */
export const INDUSTRIAL_PRIORITY_EVENT = 'ci-industrial-priority-sync'

export type IndustrialPriorityDetail = {
  source: 'po_is_priority' | 'line_director_priority'
  at: string
}

export function broadcastIndustrialPriorityChange(detail: IndustrialPriorityDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(INDUSTRIAL_PRIORITY_EVENT, { detail }))
}
