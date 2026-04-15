import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { executePrePressFinalize, prePressFinalizeFlatSchema } from '@/lib/pre-press-finalize'
import { designerCommandSchema, parseDesignerCommand } from '@/lib/designer-command'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

/** Legacy body shape — mapped to flat finalize payload. */
const legacySchema = z.object({
  setNumber: z.string().min(1, 'Set number is required'),
  artworkCode: z.string().min(1, 'Artwork code is required'),
  customerApprovalPharma: z.literal(true),
  shadeCardQaTextApproval: z.literal(true),
  assignedDesignerId: z.string().optional().nullable(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const legacy = legacySchema.safeParse(body)
  if (!legacy.success) {
    const fields: Record<string, string> = {}
    legacy.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const line = await db.poLineItem.findUnique({
    where: { id },
    select: { specOverrides: true },
  })
  const spec = (line?.specOverrides as Record<string, unknown> | null) || {}
  const designerCommand = designerCommandSchema.parse(parseDesignerCommand(spec.designerCommand))

  const flat = {
    poLineId: id,
    setNumber: legacy.data.setNumber,
    awCode: legacy.data.artworkCode,
    customerApproval: legacy.data.customerApprovalPharma,
    qaTextCheckApproval: legacy.data.shadeCardQaTextApproval,
    assignedDesignerId: legacy.data.assignedDesignerId,
    designerCommand,
    status: 'PUSH_TO_PRODUCTION_QUEUE' as const,
  }
  const parsed = prePressFinalizeFlatSchema.safeParse(flat)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
  }

  try {
    const result = await executePrePressFinalize(parsed.data, user!.id)
    return NextResponse.json({
      ok: true,
      requirementCode: result.requirementCode,
      prePressSentToPlateHubAt: result.prePressSentToPlateHubAt,
      plateHubPayload: result.plateHubPayload,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Finalize failed'
    if (msg === 'ALREADY_FINALIZED') {
      const line = await db.poLineItem.findUnique({
        where: { id },
        select: { specOverrides: true },
      })
      const spec = (line?.specOverrides as Record<string, unknown> | null) || {}
      return NextResponse.json(
        {
          error: 'Already sent to Plate Hub',
          requirementCode: spec.lastPlateRequirementCode as string | undefined,
        },
        { status: 409 },
      )
    }
    if (msg === 'SET_NUMBER_NUMERIC') {
      return NextResponse.json(
        { error: 'Validation failed', fields: { setNumber: 'Set number must be numeric' } },
        { status: 400 },
      )
    }
    if (msg === 'DIE_SOURCE_REQUIRED' || msg === 'PLATE_SET_TYPE_REQUIRED' || msg === 'EMBOSS_SOURCE_REQUIRED') {
      return NextResponse.json(
        {
          error:
            'Designer command incomplete on this line — open the designing detail screen and complete Section 3.',
        },
        { status: 400 },
      )
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
