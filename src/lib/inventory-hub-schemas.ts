import { z } from 'zod'

export const shadeCardInitialConditionSchema = z.enum(['mint', 'used', 'minor_damage'])

export const inventoryIssueBodySchema = z
  .object({
    machineId: z.string().min(1, 'machineId is required'),
    operatorUserId: z.string().uuid('operatorUserId must be a valid UUID').optional(),
    /** Free-text operator when not picking a directory user (floor speed). */
    operatorName: z.string().min(1).max(120).optional(),
    /** Optional production job card assignment (shade custody). */
    jobCardId: z.string().uuid().optional().nullable(),
    /** Physical condition at checkout (shade cards only; defaults mint). */
    initialCondition: shadeCardInitialConditionSchema.optional(),
  })
  .refine((d) => Boolean(d.operatorUserId?.trim()) || Boolean(d.operatorName?.trim()), {
    message: 'Operator is required (pick a user or enter a name)',
  })

/** Shade card issue: custody handshake requires an active production job link. */
export const shadeCardIssueBodySchema = z
  .object({
    machineId: z.string().min(1, 'machineId is required'),
    operatorUserId: z.string().uuid('operatorUserId must be a valid UUID').optional(),
    operatorName: z.string().min(1).max(120).optional(),
    jobCardId: z.string().uuid('Link an active production job (job card)'),
    initialCondition: shadeCardInitialConditionSchema.optional(),
  })
  .refine((d) => Boolean(d.operatorUserId?.trim()) || Boolean(d.operatorName?.trim()), {
    message: 'Operator is required (pick a user from the staff directory)',
  })

export const inventoryReceiveBodySchema = z.object({
  finalImpressions: z.number().int().min(0),
  condition: z.enum(['Good', 'Damaged', 'Needs Repair']),
})

/** Shade card return-to-rack — custody handshake with operator attestation. */
export const shadeCardReceiveBodySchema = z
  .object({
    finalImpressions: z.number().int().min(0).optional().default(0),
    /** @deprecated Prefer endCondition + returning operator */
    usable: z.boolean().optional(),
    endCondition: z.enum(['mint', 'used', 'minor_damage']).optional(),
    returningOperatorUserId: z.string().uuid().optional(),
    returningOperatorName: z.string().min(1).max(120).optional(),
  })
  .superRefine((d, ctx) => {
    const legacy = d.usable !== undefined
    const modern = d.endCondition != null
    if (!legacy && !modern) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide endCondition (mint / used / minor_damage) or legacy usable flag',
        path: ['endCondition'],
      })
      return
    }
    if (modern) {
      if (!d.returningOperatorUserId?.trim() && !d.returningOperatorName?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Returning operator required (staff directory or name)',
          path: ['returningOperatorUserId'],
        })
      }
    }
  })

/** Receive from vendor → in_stock (triage complete). */
export const inventoryReceiveVendorBodySchema = z.object({
  notes: z.string().max(500).optional().nullable(),
  condition: z.enum(['Good', 'Damaged', 'Needs Repair']).optional(),
})

export const shadeCardCreateSchema = z
  .object({
    shadeCode: z.string().min(1).optional(),
    autoGenerateCode: z.boolean().optional().default(true),
    /** Product Master = carton id */
    productId: z.string().uuid('Product master is required'),
    mfgDate: z.string().min(1, 'Manufacturing date is required'),
    substrateType: z.enum(['FBB', 'SBS', 'GREY_BACK', 'KRAFT'], {
      errorMap: () => ({ message: 'Substrate type is required' }),
    }),
    labL: z.number().finite(),
    labA: z.number().finite(),
    labB: z.number().finite(),
    masterArtworkRef: z.string().optional().nullable(),
    /** Denormalized label; server fills from carton when omitted */
    productMaster: z.string().optional().nullable(),
    quantity: z.number().int().min(1).max(99).optional().default(1),
    remarks: z.string().max(2000).optional().nullable(),
    approvalDate: z.string().optional().nullable(),
    inkComponent: z.string().optional().nullable(),
    currentHolder: z.string().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.autoGenerateCode === false && !data.shadeCode?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'shadeCode is required when autoGenerateCode is false',
        path: ['shadeCode'],
      })
    }
  })
