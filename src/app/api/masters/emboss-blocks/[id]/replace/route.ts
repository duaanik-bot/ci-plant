// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { replaceBlock } from '@/lib/emboss-block-service'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const replaceSchema = z.object({
  newBlockCode: z.string().min(1, 'New block code is required'),
  destroyReason: z.string().min(1, 'Reason is required'),
  blockType: z.string().optional(),
  blockMaterial: z.string().optional(),
  supervisorId: z.string().min(1, 'Supervisor is required'),
  operatorId: z.string().min(1, 'Operator is required'),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id: oldBlockId } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = replaceSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = (i.path[0] as string) ?? ''
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data

  try {
    const result = await replaceBlock(oldBlockId, data.newBlockCode, {
      blockType: data.blockType ?? '',
      blockMaterial: data.blockMaterial ?? '',
      destroyReason: data.destroyReason,
      supervisorId: data.supervisorId,
      operatorId: data.operatorId,
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'emboss_blocks',
      recordId: oldBlockId,
      newValue: {
        action: 'REPLACE',
        oldBlock: result.oldBlock.blockCode,
        newBlock: result.newBlock.blockCode,
      },
    })

    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Replace failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
