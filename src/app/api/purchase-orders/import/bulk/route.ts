import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_FILES_PER_BATCH = 20
const MAX_PDF_BYTES = 8 * 1024 * 1024 // 8 MB per file — matches single-file route

/**
 * Bulk PO import — accepts up to MAX_FILES_PER_BATCH PDFs in one multipart
 * upload. Creates a PoImportJob + N PoImportItem rows (status='pending') and
 * fires off the per-item processor in the background. Returns the jobId so
 * the inbox UI can poll GET /api/purchase-orders/import/jobs/[id].
 *
 * Processing is intentionally out-of-band (a fetch to the per-item route)
 * so each PDF gets its own 300s timeout budget and one failure can't take
 * down the batch.
 */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'AI extraction is unavailable — ANTHROPIC_API_KEY not configured.', code: 'AI_UNAVAILABLE' },
      { status: 503 },
    )
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) {
    return NextResponse.json({ error: 'At least one PDF file is required' }, { status: 400 })
  }
  if (files.length > MAX_FILES_PER_BATCH) {
    return NextResponse.json(
      { error: `At most ${MAX_FILES_PER_BATCH} files per batch` },
      { status: 413 },
    )
  }

  // Validate each file up front so a bad PDF doesn't create a half-baked job.
  for (const f of files) {
    if (f.size === 0) {
      return NextResponse.json({ error: `${f.name} is empty` }, { status: 400 })
    }
    if (f.size > MAX_PDF_BYTES) {
      return NextResponse.json(
        { error: `${f.name} exceeds ${MAX_PDF_BYTES / 1024 / 1024} MB` },
        { status: 413 },
      )
    }
    if (!f.type.includes('pdf') && !f.name.toLowerCase().endsWith('.pdf')) {
      return NextResponse.json({ error: `${f.name} is not a PDF` }, { status: 400 })
    }
  }

  // Read all bytes up front. At MAX_FILES_PER_BATCH × MAX_PDF_BYTES = 160 MB
  // worst case, which is acceptable for a synchronous upload step.
  const byteBuffers = await Promise.all(
    files.map(async (f) => Buffer.from(await f.arrayBuffer())),
  )

  const job = await db.poImportJob.create({
    data: {
      createdBy: user.id,
      fileCount: files.length,
      items: {
        create: files.map((f, i) => ({
          filename: f.name,
          pdfBytes: byteBuffers[i],
          status: 'pending',
        })),
      },
    },
    select: { id: true, items: { select: { id: true } } },
  })

  // Fire-and-forget per-item processing. We don't await — the inbox UI polls
  // for status. Use the request's own origin so this works in preview/prod
  // without hardcoding the deployment URL.
  const origin = req.nextUrl.origin
  const cookie = req.headers.get('cookie') ?? ''
  for (const item of job.items) {
    // Intentionally not awaited; not catching either because the processor
    // route writes its own failure state to the row.
    void fetch(`${origin}/api/purchase-orders/import/process-item/${item.id}`, {
      method: 'POST',
      headers: { cookie },
    })
  }

  return NextResponse.json({ ok: true, jobId: job.id, itemCount: files.length })
}
