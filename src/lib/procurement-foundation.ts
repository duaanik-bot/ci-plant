export const PR_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending: 'Pending Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  converted_to_po: 'Converted To PO',
}

export const PO_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  confirmed: 'Sent',
  sent: 'Sent',
  partial_received: 'Partially Received',
  received: 'Fully Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

export const GRN_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  RECEIVED: 'Received',
  QC_PENDING: 'QC Pending',
  PASSED: 'QC Accepted',
  PASSED_WITH_PENALTY: 'QC Accepted',
  FAILED: 'QC Rejected',
  POSTED_TO_STOCK: 'Posted To Stock',
  CANCELLED: 'Cancelled',
}

export function n(v: unknown): number {
  const out = Number(v)
  return Number.isFinite(out) ? out : 0
}

export function ymd(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

export function prNumber(id: string, raisedAt: Date | string): string {
  const d = raisedAt instanceof Date ? raisedAt : new Date(raisedAt)
  const yyyy = Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear()
  return `PR-${yyyy}-${id.slice(0, 8).toUpperCase()}`
}

export function grnNumber(id: string, receiptDate: Date | string): string {
  const d = receiptDate instanceof Date ? receiptDate : new Date(receiptDate)
  const yyyy = Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear()
  return `GRN-${yyyy}-${id.slice(0, 8).toUpperCase()}`
}

export function nextVendorPoNumber(lastPoNumber: string | null): string {
  const year = new Date().getFullYear()
  const prefix = `CI-VPO-${year}-`
  if (!lastPoNumber?.startsWith(prefix)) return `${prefix}0001`
  const lastSeq = parseInt(lastPoNumber.replace(prefix, ''), 10) || 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

export function priorityFromTrigger(triggerReason: string | null | undefined): string {
  const raw = (triggerReason ?? '').toLowerCase()
  if (raw.includes('critical')) return 'Critical'
  if (raw.includes('high') || raw.includes('urgent')) return 'High'
  if (raw.includes('low')) return 'Low'
  return 'Medium'
}

export function sourceFromTrigger(triggerReason: string | null | undefined): string {
  const raw = (triggerReason ?? '').toLowerCase()
  if (raw.includes('planning')) return 'Planning'
  if (raw.includes('warehouse')) return 'Warehouse'
  return 'Manual'
}

export function clampLimit(raw: string | null, fallback = 50, max = 100): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(1, Math.floor(n)))
}

export function pageSkip(page: string | null, limit: number): number {
  const p = Number(page)
  if (!Number.isFinite(p) || p <= 1) return 0
  return (Math.floor(p) - 1) * limit
}

export function poOperationalStatus(status: string | null | undefined): string {
  if (status === 'confirmed') return 'sent'
  if (status === 'received') return 'fully_received'
  return status || 'draft'
}

export function grnQcLabel(acceptedQty: number, rejectedQty: number, receivedQty: number, rawStatus?: string | null): string {
  if (rawStatus === 'POSTED_TO_STOCK') return 'POSTED_TO_STOCK'
  if (rawStatus === 'CANCELLED') return 'CANCELLED'
  if (rawStatus === 'DRAFT') return 'DRAFT'
  if (acceptedQty <= 0 && rejectedQty <= 0) return 'QC_PENDING'
  if (acceptedQty > 0 && rejectedQty > 0) return 'PARTIALLY_ACCEPTED'
  if (acceptedQty >= receivedQty && rejectedQty === 0) return 'QC_ACCEPTED'
  if (rejectedQty >= receivedQty && acceptedQty === 0) return 'QC_REJECTED'
  return rawStatus || 'QC_PENDING'
}
