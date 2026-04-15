import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonParse } from '@/lib/safe-json'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  machineId: z.string().uuid(),
  operatorUserId: z.string().uuid(),
  artworkId: z.string().min(1, 'artworkId is required'),
  jobCardId: z.string().min(1, 'jobCardId is required'),
  setNumber: z.string().min(1, 'setNumber is required'),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const text = await req.text()
  const raw = safeJsonParse<unknown>(text, {})
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const msg = first
      ? `Missing or invalid field: ${first.path.join('.') || 'body'}`
      : 'Validation failed'
    return NextResponse.json(
      { error: msg, details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const plate = await db.plateStore.findUnique({ where: { id } })
  if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })

  const [machine, operator] = await Promise.all([
    db.machine.findUnique({ where: { id: parsed.data.machineId } }),
    db.user.findUnique({ where: { id: parsed.data.operatorUserId }, select: { name: true } }),
  ])
  if (!machine) return NextResponse.json({ error: 'Machine not found' }, { status: 404 })
  if (!operator) return NextResponse.json({ error: 'Operator not found' }, { status: 404 })

  const label = `${machine.machineCode} / ${operator.name}`

  const issueSnapshot = {
    action: 'custody_issue' as const,
    machineId: machine.id,
    operatorUserId: parsed.data.operatorUserId,
    artworkId: parsed.data.artworkId,
    jobCardId: parsed.data.jobCardId,
    setNumber: parsed.data.setNumber,
  }

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.plateStore.update({
      where: { id },
      data: {
        status: 'issued',
        issuedTo: label,
        issuedAt: new Date(),
      },
    })
    await tx.auditLog.create({
      data: {
        userId: user!.id,
        action: 'UPDATE',
        tableName: 'plate_store',
        recordId: id,
        newValue: issueSnapshot as object,
      },
    })
    return u
  })

  return NextResponse.json({ ok: true, plate: updated })
}
