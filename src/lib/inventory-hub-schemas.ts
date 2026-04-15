import { z } from 'zod'

export const inventoryIssueBodySchema = z.object({
  machineId: z.string().min(1, 'machineId is required'),
  operatorUserId: z.string().uuid('operatorUserId must be a valid UUID'),
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
    productMaster: z.string().optional().nullable(),
    masterArtworkRef: z.string().optional().nullable(),
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
