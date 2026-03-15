import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: jobId } = await context.params

  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { id: true, jobNumber: true, productName: true, artworkId: true },
  })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const artworks = await db.artwork.findMany({
    where: { jobId },
    include: {
      approvals: { orderBy: { lockNumber: 'asc' } },
      uploader: { select: { name: true } },
    },
    orderBy: { versionNumber: 'desc' },
  })

  const current = artworks.find((a) => a.id === job.artworkId) ?? artworks[0]

  return NextResponse.json({
    job: { id: job.id, jobNumber: job.jobNumber, productName: job.productName },
    artworks,
    currentArtwork: current ?? null,
  })
}
