import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const [issueRecords, auditLog] = await Promise.all([
    db.plateIssueRecord.findMany({
      where: { plateStoreId: id },
      orderBy: { issuedAt: 'desc' },
    }),
    db.plateAuditLog.findMany({
      where: { plateStoreId: id },
      orderBy: { performedAt: 'desc' },
    }),
  ])

  return NextResponse.json({ issueRecords, auditLog })
}
