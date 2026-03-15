import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

const bodySchema = z.object({
  qty: z.number().positive(),
  instrumentReadings: z.record(z.string()).optional(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole(
    'qa_officer',
    'qa_manager',
    'operations_head',
    'md'
  )
  if (error) return error

  const { id } = await context.params
  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'qty required', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const inv = await db.inventory.findUnique({ where: { id } })
  if (!inv) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const qtyQuarantine = Number(inv.qtyQuarantine)
  if (parsed.data.qty > qtyQuarantine) {
    return NextResponse.json(
      { error: `Only ${qtyQuarantine} in quarantine` },
      { status: 400 }
    )
  }

  await db.inventory.update({
    where: { id },
    data: {
      qtyQuarantine: { decrement: parsed.data.qty },
      qtyAvailable: { increment: parsed.data.qty },
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'inventory',
    recordId: id,
    newValue: { releaseFromQuarantine: parsed.data.qty, instrumentReadings: parsed.data.instrumentReadings },
  })

  return NextResponse.json({
    success: true,
    message: `${parsed.data.qty} ${inv.unit} released to available.`,
  })
}
