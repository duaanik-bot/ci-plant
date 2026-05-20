import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { summariseInboxItems, isAllDone } from '@/lib/po-import-inbox'

export const dynamic = 'force-dynamic'

/**
 * Returns the status of every item in a bulk PO import job. The inbox UI
 * polls this every ~2s while any item is still pending/extracting.
 *
 * Intentionally omits the big payloads (`extracted`, `catalog`, `pdfBytes`)
 * from the list view — the drawer fetches a single item separately.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { error, user } = await requireAuth()
  if (error) return error
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const job = await db.poImportJob.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      createdBy: true,
      fileCount: true,
      createdAt: true,
      items: {
        select: {
          id: true,
          filename: true,
          status: true,
          customerId: true,
          errorMessage: true,
          committedPoId: true,
          createdAt: true,
          // Light summaries for the inbox table (line count, customer name from detection).
          detection: true,
          extracted: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  // Basic ownership check — bulk uploads are personal worklists.
  if (job.createdBy !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const items = summariseInboxItems(job.items)
  const allDone = isAllDone(items)

  return NextResponse.json({
    ok: true,
    job: { id: job.id, fileCount: job.fileCount, createdAt: job.createdAt, allDone },
    items,
  })
}
