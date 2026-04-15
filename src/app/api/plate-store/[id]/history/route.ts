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
  const [issueCandidates, storeAudits] = await Promise.all([
    db.auditLog.findMany({
      where: { tableName: 'plate_store_issue' },
      orderBy: { timestamp: 'desc' },
      take: 120,
    }),
    db.auditLog.findMany({
      where: { tableName: 'plate_store', recordId: id },
      orderBy: { timestamp: 'desc' },
      take: 80,
    }),
  ])
  const issueRecords = issueCandidates.filter((row) => {
    const v = row.newValue as Record<string, unknown> | null | undefined
    return v != null && String(v.plateStoreId ?? '') === id
  })

  return NextResponse.json({ issueRecords, auditLog: storeAudits })
}
