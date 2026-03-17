import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

function buildQtNumber(existingMax: string | null): string {
  const year = new Date().getFullYear()
  const prefix = `QT-${year}-`
  if (!existingMax || !existingMax.startsWith(prefix)) return `${prefix}0001`
  const lastSeq = parseInt(existingMax.replace(prefix, ''), 10) || 0
  return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
}

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const last = await db.rfq.findFirst({
    where: { quotationNumber: { not: null } },
    orderBy: { quotationNumber: 'desc' },
    select: { quotationNumber: true },
  })

  return NextResponse.json({ quotationNumber: buildQtNumber(last?.quotationNumber ?? null) })
}

