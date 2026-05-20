/**
 * Pure helpers for the bulk PO import inbox.
 *
 * The bulk-import flow stores one PoImportItem per uploaded PDF and each one
 * carries its own `extracted` / `detection` JSON. This file holds the
 * presentation-shaping logic so it can be unit-tested without a DB —
 * specifically the guarantee that N uploaded PDFs stay as N independent
 * rows and never collapse into one PO.
 */

export type RawInboxItem = {
  id: string
  filename: string
  status: string
  errorMessage: string | null
  committedPoId: string | null
  detection: unknown
  extracted: unknown
  createdAt: Date | string
}

export type InboxItemSummary = {
  id: string
  filename: string
  status: string
  errorMessage: string | null
  committedPoId: string | null
  customerName: string | null
  customerConfidence: number | null
  poNumber: string | null
  lineCount: number | null
  /** Filename of the earlier item in this batch with the same poNumber, if any. */
  duplicateOf: string | null
  createdAt: Date | string
}

type DetectionShape = {
  matchedCustomerName?: string | null
  newCustomerProposal?: { name?: string } | null
  confidence?: number
}

type ExtractedShape = {
  poNumber?: string
  lineItems?: Array<unknown>
}

/**
 * Summarise PoImportItem rows for the inbox table. Preserves a strict 1-to-1
 * mapping from input rows to output entries — never groups, merges, or
 * deduplicates rows. The only collapsing we do is *flagging* duplicate
 * poNumbers via `duplicateOf` so the operator can spot accidental re-uploads
 * before they hit the DB's unique constraint at commit time.
 */
export function summariseInboxItems(items: RawInboxItem[]): InboxItemSummary[] {
  // Track the FIRST occurrence of each poNumber within this batch. Later
  // occurrences get `duplicateOf` pointing back at the earlier filename.
  const firstSeen = new Map<string, string>() // normalised poNumber → filename

  return items.map((it) => {
    const detection = (it.detection ?? null) as DetectionShape | null
    const extracted = (it.extracted ?? null) as ExtractedShape | null
    const poNumber = typeof extracted?.poNumber === 'string' ? extracted.poNumber : null

    let duplicateOf: string | null = null
    if (poNumber) {
      const key = poNumber.trim().toUpperCase()
      const earlier = firstSeen.get(key)
      if (earlier) {
        duplicateOf = earlier
      } else {
        firstSeen.set(key, it.filename)
      }
    }

    return {
      id: it.id,
      filename: it.filename,
      status: it.status,
      errorMessage: it.errorMessage,
      committedPoId: it.committedPoId,
      customerName:
        detection?.matchedCustomerName ?? detection?.newCustomerProposal?.name ?? null,
      customerConfidence: detection?.confidence ?? null,
      poNumber,
      lineCount: Array.isArray(extracted?.lineItems) ? extracted!.lineItems!.length : null,
      duplicateOf,
      createdAt: it.createdAt,
    }
  })
}

/** Terminal statuses — the inbox stops polling once every item is in one. */
const TERMINAL = new Set(['ready', 'needs_review', 'failed', 'committed'])

export function isAllDone(items: { status: string }[]): boolean {
  return items.every((it) => TERMINAL.has(it.status))
}
