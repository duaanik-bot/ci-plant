import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { extractPoPdfText } from '@/lib/po-pdf-extract'
import {
  extractPoWithClaude,
  type CartonCatalogItem,
  type ExtractedPo,
} from '@/lib/po-claude-extract'

export const dynamic = 'force-dynamic'
// PDF extract + LLM call can run long; bump per Vercel Fluid defaults.
export const maxDuration = 300

const MAX_PDF_BYTES = 8 * 1024 * 1024 // 8 MB

type ExtractResponse = {
  ok: true
  customerId: string
  customerName: string
  source: { filename: string; pageCount: number }
  extracted: ExtractedPo
  /** Carton catalog the LLM used — UI uses this for the per-line dropdown. */
  catalog: CartonCatalogItem[]
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

  const customerId = (form.get('customerId') as string | null)?.trim() || ''
  const file = form.get('file')
  if (!customerId) {
    return NextResponse.json({ error: 'customerId is required' }, { status: 400 })
  }
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

  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: { id: true, name: true },
  })
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
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

  const cartons = await db.carton.findMany({
    where: { customerId, active: true },
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
  }

  return NextResponse.json(payload)
}
