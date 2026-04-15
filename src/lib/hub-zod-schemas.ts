import { z } from 'zod'

/** Hub custody return — strict IDs for traceability (required before DB). */
export const hubCustodyReturnBodySchema = z.object({
  toolType: z.enum(['dies', 'blocks']),
  recordId: z.string().min(1, 'recordId required'),
  impressions: z.number().int().min(0),
  rackSlot: z.string().min(1, 'rackSlot required'),
  condition: z.enum(['Good', 'Damaged', 'Needs Repair']).optional(),
  jobCardId: z.string().uuid({ message: 'jobCardId must be a valid UUID' }),
  artworkId: z.string().uuid({ message: 'artworkId must be a valid UUID' }),
  setNumber: z.string().min(1, 'setNumber is required'),
})

export type HubCustodyReturnBody = z.infer<typeof hubCustodyReturnBodySchema>
