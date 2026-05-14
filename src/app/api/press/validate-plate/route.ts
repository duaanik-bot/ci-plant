import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { isArtworkLocked } from '@/lib/planning-interlock'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  plateBarcode: z.string().min(1),
  jobId: z.string().uuid().optional(),
  machineCode: z.string().min(1).optional(),
})

const READY_STATUSES = new Set(['plates_ready', 'plates_imaged', 'ready_inventory', 'burning_complete'])

/**
 * Press-operator plate validation. After the 4-lock artwork workflow was retired
 * (commit deprecating Artwork / ArtworkApproval), plate barcodes live on
 * PlateRequirement.plateBarcode and the press-side check looks up the
 * requirement, the linked PO line, and the artwork-locked seal directly.
 */
export async function POST(req: NextRequest) {
  const { error, user: _user } = await requireRole(
    'press_operator',
    'shift_supervisor',
    'production_manager',
    'md',
  )
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'plateBarcode required' }, { status: 400 })
  }

  const { plateBarcode, jobId } = parsed.data

  const requirement = await db.plateRequirement.findUnique({ where: { plateBarcode } })

  if (!requirement) {
    return NextResponse.json(
      {
        valid: false,
        message:
          '❌ Plate barcode not recognised. Check plate is correct. Contact your supervisor immediately.',
      },
      { status: 400 },
    )
  }

  if (!READY_STATUSES.has(requirement.status)) {
    return NextResponse.json(
      {
        valid: false,
        message: `❌ DO NOT RUN. Plate not ready — requirement ${requirement.requirementCode} is ${requirement.status}. Contact your supervisor immediately.`,
      },
      { status: 400 },
    )
  }

  const poLine = requirement.poLineId
    ? await db.poLineItem.findUnique({
        where: { id: requirement.poLineId },
        include: { po: { include: { customer: { select: { name: true } } } } },
      })
    : null

  const spec = (poLine?.specOverrides as Record<string, unknown> | null) || null
  if (!isArtworkLocked(spec)) {
    return NextResponse.json(
      {
        valid: false,
        message:
          '❌ DO NOT RUN. Artwork approvals not in place for the linked PO line. Contact your supervisor immediately.',
      },
      { status: 400 },
    )
  }

  if (jobId && poLine?.jobCardNumber) {
    const jc = await db.productionJobCard.findFirst({
      where: { jobCardNumber: poLine.jobCardNumber },
      select: { id: true, jobCardNumber: true },
    })
    if (jc && jc.id !== jobId) {
      return NextResponse.json(
        {
          valid: false,
          message: `❌ WRONG PLATE. This plate belongs to JC#${jc.jobCardNumber}, not the scanned job. Do not proceed. Contact your supervisor immediately.`,
        },
        { status: 400 },
      )
    }
  }

  return NextResponse.json({
    valid: true,
    message: `✅ PRESS CLEARED\nPO: ${poLine?.po.poNumber ?? '—'}\nCustomer: ${poLine?.po.customer.name ?? '—'}\nArtwork: ${requirement.artworkCode ?? '—'} ${requirement.artworkVersion ?? ''}\nRequirement: ${requirement.requirementCode}`,
    artworkVersion: requirement.artworkVersion ?? null,
    requirementCode: requirement.requirementCode,
    artworkCode: requirement.artworkCode ?? null,
    poNumber: poLine?.po.poNumber ?? null,
    customerName: poLine?.po.customer.name ?? null,
  })
}
