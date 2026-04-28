import { z } from 'zod'
import { getPostPressRouting } from '@/lib/emboss-conditions'

/** Persisted on `ProductionJobCard.postPressRouting` JSON (additive fields OK). */
export const printPlanSchema = z.object({
  lane: z.enum(['triage', 'machine']),
  machineId: z.string().uuid().optional().nullable(),
  order: z.number().int().min(0),
  updatedAt: z.string().optional(),
})

export const postPressRoutingSchema = z
  .object({
    chemicalCoating: z.boolean().optional(),
    lamination: z.boolean().optional(),
    spotUv: z.boolean().optional(),
    leafing: z.boolean().optional(),
    embossing: z.boolean().optional(),
    printPlan: printPlanSchema.optional(),
  })
  .passthrough()

export type PostPressRoutingPayload = z.infer<typeof postPressRoutingSchema>

type PoLineLike = {
  embossingLeafing?: string | null
  coatingType?: string | null
  carton?: {
    embossingLeafing?: string | null
    coatingType?: string | null
    laminateType?: string | null
    foilType?: string | null
  } | null
}

/** Maps carton/line fields to stored post-press flags (same shape as job card UI). */
export function postPressRoutingFromPoLine(li: PoLineLike): PostPressRoutingPayload {
  const carton = li.carton
  const routing = getPostPressRouting({
    embossingLeafing: carton?.embossingLeafing ?? li.embossingLeafing,
    coatingType: carton?.coatingType ?? li.coatingType,
    laminateType: carton?.laminateType ?? null,
  })
  const foil = (carton?.foilType ?? '').toLowerCase()
  return {
    chemicalCoating: routing.needsChemicalCoating,
    lamination: routing.needsLamination,
    spotUv: routing.needsSpotUv,
    leafing: foil !== '' && foil !== 'none',
    embossing: routing.needsEmbossing,
  }
}
