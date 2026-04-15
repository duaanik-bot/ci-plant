import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Log a knife re-edge / sharpening event (count via audit trail). */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'die_sharpening',
    recordId: id,
    newValue: { at: new Date().toISOString(), dieId: id },
  })

  const count = await db.auditLog.count({
    where: { tableName: 'die_sharpening', recordId: id },
  })

  return NextResponse.json({ ok: true, sharpenCount: count })
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const count = await db.auditLog.count({
    where: { tableName: 'die_sharpening', recordId: id },
  })
  return NextResponse.json({ sharpenCount: count })
}
