import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const [issueRecords, maintenanceLogs, auditLog] = await Promise.all([
    db.embossIssueRecord.findMany({ where: { embossBlockId: id }, orderBy: { issuedAt: 'desc' } }),
    db.embossMaintenanceLog.findMany({ where: { embossBlockId: id }, orderBy: { performedAt: 'desc' } }),
    db.embossAuditLog.findMany({ where: { embossBlockId: id }, orderBy: { performedAt: 'desc' } }),
  ])
  return NextResponse.json({ issueRecords, maintenanceLogs, auditLog })
}

