import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { executePrePressFinalize, prePressFinalizeFlatSchema } from '@/lib/pre-press-finalize'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = prePressFinalizeFlatSchema.safeParse(raw)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.') || '_root'
      if (!fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
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
    if (msg === 'PO_LINE_NOT_FOUND') {
      return NextResponse.json({ error: 'PO line not found' }, { status: 404 })
    }
    if (msg === 'ALREADY_FINALIZED') {
      const line = await db.poLineItem.findUnique({
        where: { id: parsed.data.poLineId },
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
    if (msg === 'DIE_SOURCE_REQUIRED') {
      return NextResponse.json(
        { error: 'Validation failed', fields: { 'designerCommand.dieSource': 'Choose Die source (New or Old)' } },
        { status: 400 },
      )
    }
    if (msg === 'PLATE_SET_TYPE_REQUIRED') {
      return NextResponse.json(
        {
          error: 'Validation failed',
          fields: { 'designerCommand.setType': 'Choose plate set type' },
        },
        { status: 400 },
      )
    }
    if (msg === 'EMBOSS_SOURCE_REQUIRED') {
      return NextResponse.json(
        {
          error: 'Validation failed',
          fields: {
            'designerCommand.embossSource': 'Choose Emboss block source (New or Old)',
          },
        },
        { status: 400 },
      )
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
