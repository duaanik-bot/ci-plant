import { z } from 'zod'

/** Single POST body for bundled hub dispatch (die / emboss / plate context). */
export const unifiedToolingDispatchBodySchema = z.object({
  poLineId: z.string().min(1),
  jobCardId: z.string().min(1),
  artworkId: z.string().min(1),
  setNumber: z.string().min(1),
  /** Resolved from PO line — die / dye master */
  dieId: z.string().nullable().optional(),
  /** Emboss block when known */
  embossBlockId: z.string().nullable().optional(),
  /** Plate set in store when known */
  plateSetId: z.string().nullable().optional(),
  dispatchDie: z.boolean(),
  dispatchEmboss: z.boolean(),
  dieSource: z.enum(['NEW', 'OLD']).nullable().optional(),
  embossSource: z.enum(['NEW', 'OLD']).nullable().optional(),
})

export type UnifiedToolingDispatchBody = z.infer<typeof unifiedToolingDispatchBodySchema>
