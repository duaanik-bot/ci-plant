import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'

export const dynamic = 'force-dynamic'

const R2_ACCOUNT = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID
const R2_SECRET = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET = process.env.R2_BUCKET_NAME
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || ''

function getR2Client(): S3Client | null {
  if (!R2_ACCOUNT || !R2_ACCESS_KEY || !R2_SECRET) return null
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY,
      secretAccessKey: R2_SECRET,
    },
  })
}

/** POST /api/artworks/[id]/upload — id is jobId. */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('sales', 'md', 'operations_head')
  if (error) return error

  const { id: jobId } = await context.params
  const job = await db.job.findUnique({ where: { id: jobId } })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file || file.size === 0) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
  }

  const ext = file.name.split('.').pop() || 'bin'
  const key = `artworks/${jobId}/${nanoid(12)}.${ext}`
  let fileUrl = key

  const client = getR2Client()
  if (client && R2_BUCKET) {
    try {
      const buffer = Buffer.from(await file.arrayBuffer())
      await client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: file.type || 'application/octet-stream',
        })
      )
      fileUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}` : key
    } catch (e) {
      console.error('[R2] Upload failed:', e)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }
  }

  const lastVersion = await db.artwork.findFirst({
    where: { jobId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })
  const versionNumber = (lastVersion?.versionNumber ?? 0) + 1

  const artwork = await db.artwork.create({
    data: {
      jobId,
      versionNumber,
      filename: file.name,
      fileUrl,
      status: 'pending',
      locksCompleted: 0,
      uploadedBy: user!.id,
    },
  })

  await db.job.update({
    where: { id: jobId },
    data: { artworkId: artwork.id },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'artworks',
    recordId: artwork.id,
    newValue: { jobId, versionNumber, filename: file.name },
  })

  return NextResponse.json(artwork, { status: 201 })
}
