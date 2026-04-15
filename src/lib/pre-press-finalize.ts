import { db } from '@/lib/db'
import { createPlateRequirementFromPoLine } from '@/lib/plate-engine'
import { mergeOrchestrationIntoSpec, PLATE_FLOW } from '@/lib/orchestration-spec'
import {
  designerCommandSchema,
  type DesignerCommand,
} from '@/lib/designer-command'
import { isEmbossingRequired } from '@/lib/emboss-conditions'
import { z } from 'zod'

/** Flat payload for Plate Hub / audit (JSON-serializable primitives only). */
export type PlateHubUpsertPayload = {
  jobCardId: string | null
  setNumber: string
  awCode: string
  pharmaApproved: boolean
  status: 'PUSH_TO_PRODUCTION_QUEUE'
  designerCommand: DesignerCommand
}

/** Request body: flat object — no nested spec blobs — to avoid JSON parse issues on the client. */
export const prePressFinalizeFlatSchema = z
  .object({
    poLineId: z.string().uuid(),
    setNumber: z.string().min(1, 'Set number is required'),
    awCode: z.string().min(1, 'Artwork code is required'),
    customerApproval: z.boolean(),
    qaTextCheckApproval: z.boolean(),
    assignedDesignerId: z.string().optional().nullable(),
    designerCommand: designerCommandSchema,
    status: z.literal('PUSH_TO_PRODUCTION_QUEUE'),
  })
  .strict()
  .refine((d) => d.customerApproval === true && d.qaTextCheckApproval === true, {
    message: 'Both approvals must be true to finalize',
    path: ['customerApproval'],
  })

export type PrePressFinalizeInput = z.infer<typeof prePressFinalizeFlatSchema>

export async function executePrePressFinalize(
  input: PrePressFinalizeInput,
  userId: string,
): Promise<{
  requirementCode: string
  prePressSentToPlateHubAt: string
  plateHubPayload: PlateHubUpsertPayload
}> {
  const {
    poLineId,
    setNumber,
    awCode,
    customerApproval,
    qaTextCheckApproval,
    assignedDesignerId,
    designerCommand: designerCommandInput,
  } = input

  const setNorm = setNumber.trim()
  if (!/^\d+$/.test(setNorm)) {
    throw new Error('SET_NUMBER_NUMERIC')
  }
  const awNorm = awCode.trim()

  const designerCommand = designerCommandSchema.parse(
    designerCommandInput,
  ) as DesignerCommand

  return db.$transaction(async (tx) => {
    const existing = await tx.poLineItem.findUnique({
      where: { id: poLineId },
      include: { po: true },
    })
    if (!existing) throw new Error('PO_LINE_NOT_FOUND')

    const spec = (existing.specOverrides as Record<string, unknown> | null) || {}
    if (spec.prePressSentToPlateHubAt) {
      throw new Error('ALREADY_FINALIZED')
    }

    if (!designerCommand.dieSource) {
      throw new Error('DIE_SOURCE_REQUIRED')
    }
    if (!designerCommand.setType) {
      throw new Error('PLATE_SET_TYPE_REQUIRED')
    }
    if (isEmbossingRequired(existing.embossingLeafing) && !designerCommand.embossSource) {
      throw new Error('EMBOSS_SOURCE_REQUIRED')
    }

    const jc = existing.jobCardNumber
      ? await tx.productionJobCard.findFirst({
          where: { jobCardNumber: existing.jobCardNumber },
          select: { id: true },
        })
      : null

    const nextSpec = {
      ...spec,
      customerApprovalPharma: customerApproval,
      shadeCardQaTextApproval: qaTextCheckApproval,
      assignedDesignerId: assignedDesignerId || undefined,
      designerCommand,
    }

    await tx.poLineItem.update({
      where: { id: poLineId },
      data: {
        setNumber: setNorm,
        artworkCode: awNorm,
        specOverrides: nextSpec as object,
      },
    })

    const { requirementCode } = await createPlateRequirementFromPoLine(poLineId, userId, tx)

    const sentAt = new Date().toISOString()
    const plateHubPayload: PlateHubUpsertPayload = {
      jobCardId: jc?.id ?? null,
      setNumber: setNorm,
      awCode: awNorm,
      pharmaApproved: !!(customerApproval && qaTextCheckApproval),
      status: 'PUSH_TO_PRODUCTION_QUEUE',
      designerCommand,
    }

    const finalSpec = {
      ...mergeOrchestrationIntoSpec(nextSpec, { plateFlowStatus: PLATE_FLOW.triage }),
      prePressSentToPlateHubAt: sentAt,
      lastPlateRequirementCode: requirementCode,
      plateHubPayload,
    }

    await tx.poLineItem.update({
      where: { id: poLineId },
      data: { specOverrides: finalSpec as object },
    })

    await tx.auditLog.create({
      data: {
        userId,
        action: 'UPDATE',
        tableName: 'po_line_items',
        recordId: poLineId,
        newValue: {
          prePressFinalizePlateHub: true,
          requirementCode,
          plateHubPayload,
        } as object,
      },
    })

    return { requirementCode, prePressSentToPlateHubAt: sentAt, plateHubPayload }
  })
}
