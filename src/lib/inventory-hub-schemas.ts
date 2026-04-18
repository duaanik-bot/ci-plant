import { z } from 'zod'

export const inventoryIssueBodySchema = z
  .object({
    machineId: z.string().min(1, 'machineId is required'),
    operatorUserId: z.string().uuid('operatorUserId must be a valid UUID').optional(),
    /** Free-text operator when not picking a directory user (floor speed). */
    operatorName: z.string().min(1).max(120).optional(),
  })
  .refine((d) => Boolean(d.operatorUserId?.trim()) || Boolean(d.operatorName?.trim()), {
    message: 'Operator is required (pick a user or enter a name)',
  })

export const inventoryReceiveBodySchema = z.object({
  finalImpressions: z.number().int().min(0),
  condition: z.enum(['Good', 'Damaged', 'Needs Repair']),
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
