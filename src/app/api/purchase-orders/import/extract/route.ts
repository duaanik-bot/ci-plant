import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { extractPoPdfText } from '@/lib/po-pdf-extract'
import {
  detectCustomerWithClaude,
  extractPoWithClaude,
  type CartonCatalogItem,
  type CustomerDetection,
  type CustomerRosterItem,
  type ExtractedPo,
} from '@/lib/po-claude-extract'
import { cityFromAddress } from '@/lib/customer-address'

export const dynamic = 'force-dynamic'
// PDF extract + LLM call can run long; bump per Vercel Fluid defaults.
export const maxDuration = 300

const MAX_PDF_BYTES = 8 * 1024 * 1024 // 8 MB

/** Sentinel id sent in place of a real Customer.id when the operator is
 *  confirming-and-creating a new customer from the PDF. The commit route
 *  matches the same literal — keep them in sync if you ever change it. */
const NEW_CUSTOMER_SENTINEL = '__new__'

type ExtractResponse = {
  ok: true
  customerId: string
  customerName: string
  source: { filename: string; pageCount: number }
  extracted: ExtractedPo
  /** Carton catalog the LLM used — UI uses this for the per-line dropdown. */
  catalog: CartonCatalogItem[]
  /**
   * Present when the customer was auto-detected from the PDF (no customerId was
   * passed in). Lets the UI flag low-confidence matches for operator review.
   */
  customerDetection: CustomerDetection | null
  /**
   * Populated when no roster match was found but Claude read a buyer off the
   * PO header. The drawer renders an editable "New customer" card and the
   * commit payload includes `newCustomer` for in-transaction creation.
   */
  proposedNewCustomer: {
    name: string
    gstNumber: string | null
    address: string | null
  } | null
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  const customerIdInput = (form.get('customerId') as string | null)?.trim() || ''
  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'A PDF file is required' }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Uploaded file is empty' }, { status: 400 })
  }
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json(
      { error: `PDF exceeds ${MAX_PDF_BYTES / 1024 / 1024} MB limit` },
      { status: 413 },
    )
  }
  if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json({ error: 'File must be a PDF' }, { status: 400 })
  }

  const buffer = new Uint8Array(await file.arrayBuffer())

  let pdf
  try {
    pdf = await extractPoPdfText(buffer)
  } catch (err) {
    console.error('[POST /api/purchase-orders/import/extract] PDF parse failed:', err)
    return NextResponse.json(
      { error: 'Could not read this PDF. It may be corrupted or password-protected.' },
      { status: 422 },
    )
  }

  if (pdf.pageCount === 0) {
    return NextResponse.json({ error: 'PDF has no pages' }, { status: 422 })
  }
  if (pdf.isLikelyScanned) {
    return NextResponse.json(
      {
        error:
          "This PDF appears to be scanned. OCR isn't supported yet — please retype, or ask the customer for a text-based PDF.",
      },
      { status: 422 },
    )
  }

  // Resolve which customer this PO belongs to. Operator pre-selection wins;
  // otherwise we run a cheap detection pass against the active customer roster.
  let customer: { id: string; name: string } | null = null
  let detection: CustomerDetection | null = null

  if (customerIdInput) {
    customer = await db.customer.findUnique({
      where: { id: customerIdInput },
      select: { id: true, name: true },
    })
    if (!customer) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
    }
  } else {
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

    try {
      detection = await detectCustomerWithClaude({
        pdfText: pdf.text,
        customerRoster: rosterSlim,
      })
    } catch (err) {
      console.error('[POST /api/purchase-orders/import/extract] Customer detect failed:', err)
      return NextResponse.json(
        {
          error: 'Could not identify the customer from this PDF. Please pick the customer manually.',
          needsCustomerSelection: true,
        },
        { status: 502 },
      )
    }

    if (!detection.matchedCustomerId) {
      // No roster match. If Claude proposed buyer details from the PDF, fall
      // through with a sentinel customer + empty catalog — the operator will
      // confirm-and-create the customer at commit time. If there's also no
      // proposal, fall back to the manual picker.
      if (!detection.newCustomerProposal) {
        return NextResponse.json(
          {
            error:
              detection.reason ||
              'Could not identify the customer from this PDF. Please pick the customer manually.',
            customerDetection: detection,
            needsCustomerSelection: true,
          },
          { status: 422 },
        )
      }
      customer = {
        id: NEW_CUSTOMER_SENTINEL,
        name: detection.newCustomerProposal.name,
      }
    } else {
      customer = roster
        .filter((c) => c.id === detection!.matchedCustomerId)
        .map((c) => ({ id: c.id, name: c.name }))[0] ?? null
      if (!customer) {
        // Shouldn't happen — detection IDs are filtered against the roster.
        return NextResponse.json({ error: 'Detected customer not found' }, { status: 500 })
      }
    }
  }

  // Cartons catalog: only fetch for a REAL customer. For new-customer flow
  // the catalog is intentionally empty so every line becomes a new-carton
  // proposal that gets created alongside the customer at commit.
  const cartons =
    customer.id === NEW_CUSTOMER_SENTINEL
      ? []
      : await db.carton.findMany({
    where: { customerId: customer.id, active: true },
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

  let extracted: ExtractedPo
  try {
    extracted = await extractPoWithClaude({
      pdfText: pdf.text,
      cartonCatalog: catalog,
    })
  } catch (err) {
    console.error('[POST /api/purchase-orders/import/extract] Claude call failed:', err)
    const message = err instanceof Error ? err.message : 'AI extraction failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  // Validate any cartonId Claude returned actually belongs to this customer.
  const validIds = new Set(catalog.map((c) => c.id))
  for (const line of extracted.lineItems) {
    if (line.matchedCartonId && !validIds.has(line.matchedCartonId)) {
      line.matchedCartonId = null
      line.matchedCartonName = null
      line.matchConfidence = Math.min(line.matchConfidence, 0.5)
    }
  }

  const payload: ExtractResponse = {
    ok: true,
    customerId: customer.id,
    customerName: customer.name,
    source: { filename: file.name, pageCount: pdf.pageCount },
    extracted,
    catalog,
    customerDetection: detection,
    proposedNewCustomer:
      customer.id === NEW_CUSTOMER_SENTINEL && detection?.newCustomerProposal
        ? detection.newCustomerProposal
        : null,
  }

  return NextResponse.json(payload)
}
