import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { extractPoPdfText } from '@/lib/po-pdf-extract'
import {
  detectCustomerWithClaude,
  extractPoWithClaude,
  type CartonCatalogItem,
  type CustomerRosterItem,
} from '@/lib/po-claude-extract'
import { cityFromAddress } from '@/lib/customer-address'

export const dynamic = 'force-dynamic'
// Same 300s ceiling as the single-file extract route — one item, one budget.
export const maxDuration = 300

const NEW_CUSTOMER_SENTINEL = '__new__'

/**
 * Per-item processor for the bulk PO inbox. The bulk-upload route enqueues
 * one fetch to this endpoint per uploaded PDF (fire-and-forget). This route
 * runs the same detect + extract pipeline as the single-file route and
 * writes the resulting status back onto the PoImportItem row.
 *
 * Final statuses:
 *   - ready         : customer matched ≥0.9 AND every line matched ≥0.9 — safe to one-click commit
 *   - needs_review  : extracted, but at least one ambiguity (new customer, new carton, low confidence)
 *   - failed        : PDF unreadable, scanned, or API error — errorMessage populated
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const { error, user } = await requireAuth()
  if (error) return error
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const item = await db.poImportItem.findUnique({
    where: { id: params.id },
    select: { id: true, status: true, pdfBytes: true, filename: true },
  })
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  // Idempotency — if the item already moved past 'pending'/'extracting', don't re-process.
  if (item.status !== 'pending' && item.status !== 'extracting') {
    return NextResponse.json({ ok: true, skipped: true, status: item.status })
  }
  if (!item.pdfBytes) {
    await markFailed(item.id, 'PDF bytes missing on this item')
    return NextResponse.json({ ok: false, status: 'failed' })
  }

  await db.poImportItem.update({ where: { id: item.id }, data: { status: 'extracting' } })

  try {
    // 1) PDF → text
    const pdf = await extractPoPdfText(new Uint8Array(item.pdfBytes))
    if (pdf.pageCount === 0) {
      await markFailed(item.id, 'PDF has no pages')
      return NextResponse.json({ ok: false, status: 'failed' })
    }
    if (pdf.isLikelyScanned) {
      await markFailed(item.id, "Scanned PDF — OCR isn't supported yet")
      return NextResponse.json({ ok: false, status: 'failed' })
    }

    // 2) Customer detect against the active roster.
    const roster = await db.customer.findMany({
      where: { active: true },
      select: { id: true, name: true, gstNumber: true, address: true },
      orderBy: { name: 'asc' },
    })
    const rosterSlim: CustomerRosterItem[] = roster.map((c) => ({
      id: c.id,
      name: c.name,
      gstNumber: c.gstNumber,
      city: cityFromAddress(c.address),
    }))
    const detection = await detectCustomerWithClaude({ pdfText: pdf.text, customerRoster: rosterSlim })

    let resolvedCustomerId: string | null = null
    let resolvedCustomerName = ''
    if (detection.matchedCustomerId) {
      const c = roster.find((r) => r.id === detection.matchedCustomerId)
      if (c) {
        resolvedCustomerId = c.id
        resolvedCustomerName = c.name
      }
    } else if (detection.newCustomerProposal) {
      resolvedCustomerId = NEW_CUSTOMER_SENTINEL
      resolvedCustomerName = detection.newCustomerProposal.name
    } else {
      // No match, no proposal — needs operator to pick manually in the drawer.
      await db.poImportItem.update({
        where: { id: item.id },
        data: { status: 'needs_review', detection: detection as object },
      })
      return NextResponse.json({ ok: true, status: 'needs_review' })
    }

    // 3) Carton catalog (empty for new-customer sentinel — every line becomes a proposal).
    const cartons =
      resolvedCustomerId === NEW_CUSTOMER_SENTINEL
        ? []
        : await db.carton.findMany({
            where: { customerId: resolvedCustomerId!, active: true },
            select: {
              id: true,
              cartonName: true,
              artworkCode: true,
              gsm: true,
              rate: true,
              gstPct: true,
              finishedLength: true,
              finishedWidth: true,
              finishedHeight: true,
            },
            take: 500,
          })
    const catalog: CartonCatalogItem[] = cartons.map((c) => ({
      id: c.id,
      cartonName: c.cartonName,
      artworkCode: c.artworkCode ?? null,
      gsm: c.gsm ?? null,
      rate: c.rate ? Number(c.rate) : null,
      gstPct: c.gstPct,
      cartonSize:
        c.finishedLength && c.finishedWidth
          ? `${Number(c.finishedLength)}x${Number(c.finishedWidth)}${c.finishedHeight ? `x${Number(c.finishedHeight)}` : ''}`
          : null,
    }))

    // 4) Extract.
    const extracted = await extractPoWithClaude({ pdfText: pdf.text, cartonCatalog: catalog })

    // Validate any cartonId Claude returned actually belongs to this customer.
    const validIds = new Set(catalog.map((c) => c.id))
    for (const line of extracted.lineItems) {
      if (line.matchedCartonId && !validIds.has(line.matchedCartonId)) {
        line.matchedCartonId = null
        line.matchedCartonName = null
        line.matchConfidence = Math.min(line.matchConfidence, 0.5)
      }
    }

    // 5) Classify status. "ready" = green-path auto-commit candidate.
    const allLinesConfident = extracted.lineItems.every(
      (l) => l.matchConfidence >= 0.9 && l.matchedCartonId,
    )
    const customerConfident =
      resolvedCustomerId !== NEW_CUSTOMER_SENTINEL && (detection.confidence ?? 0) >= 0.9
    const finalStatus = customerConfident && allLinesConfident ? 'ready' : 'needs_review'

    await db.poImportItem.update({
      where: { id: item.id },
      data: {
        status: finalStatus,
        customerId: resolvedCustomerId === NEW_CUSTOMER_SENTINEL ? null : resolvedCustomerId,
        detection: detection as object,
        extracted: extracted as unknown as object,
        catalog: catalog as unknown as object,
      },
    })
    return NextResponse.json({ ok: true, status: finalStatus, customerName: resolvedCustomerName })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Extraction failed'
    console.error('[process-item]', params.id, message)
    await markFailed(params.id, message)
    return NextResponse.json({ ok: false, status: 'failed', error: message }, { status: 502 })
  }
}

async function markFailed(itemId: string, message: string) {
  await db.poImportItem.update({
    where: { id: itemId },
    data: { status: 'failed', errorMessage: message.slice(0, 500) },
  })
}
