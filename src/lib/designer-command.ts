import { z } from 'zod'

export type ToolSource = 'new' | 'old'

export type PlateSetType = 'new_set' | 'correction_plate' | 'old_set_from_store' | ''

export type PlateRequirement = {
  standardC: boolean
  standardM: boolean
  standardY: boolean
  standardK: boolean
  /** When true, plate count uses numberOfPantones (not P1–P3 line count). */
  pantoneEnabled: boolean
  numberOfPantones: number
  pantone1: string
  pantone2: string
  pantone3: string
  specialColourNote: string
  dripOffPlate: boolean
  spotUvPlate: boolean
}

/** Live plate count for pre-press: CMYK + pantones + optional spot/drip-off plates. */
export function computeTotalPlates(pr: PlateRequirement): number {
  let n = 0
  if (pr.standardC) n += 1
  if (pr.standardM) n += 1
  if (pr.standardY) n += 1
  if (pr.standardK) n += 1
  if (pr.pantoneEnabled) {
    const p = Number(pr.numberOfPantones)
    if (Number.isFinite(p) && p > 0) n += Math.floor(p)
  }
  if (pr.dripOffPlate) n += 1
  if (pr.spotUvPlate) n += 1
  return n
}

export type ToolingDispatchIntent =
  | 'die_hub'
  | 'emboss_hub'
  | 'vendor_po'
  | 'store_retrieval'

export type DesignerCommand = {
  dieSource: ToolSource | null
  embossSource: ToolSource | null
  plateRequirement: PlateRequirement
  setType: PlateSetType
  /** Last explicit tool actions (audit trail) */
  dieLastIntent?: ToolingDispatchIntent | null
  embossLastIntent?: ToolingDispatchIntent | null
  dieLastIntentAt?: string
  embossLastIntentAt?: string
  /** Standalone plate hub dispatch (pre-finalize routing signal). */
  plateHubDispatchAt?: string
}

export function defaultDesignerCommand(): DesignerCommand {
  return {
    dieSource: null,
    embossSource: null,
    plateRequirement: {
      standardC: true,
      standardM: true,
      standardY: true,
      standardK: true,
      pantoneEnabled: false,
      numberOfPantones: 0,
      pantone1: '',
      pantone2: '',
      pantone3: '',
      specialColourNote: '',
      dripOffPlate: false,
      spotUvPlate: false,
    },
    setType: '',
  }
}

export function parseDesignerCommand(raw: unknown): DesignerCommand {
  const base = defaultDesignerCommand()
  if (!raw || typeof raw !== 'object') return base
  const d = raw as Record<string, unknown>
  const die =
    d.dieSource === 'new' || d.dieSource === 'old' ? (d.dieSource as ToolSource) : null
  const emb =
    d.embossSource === 'new' || d.embossSource === 'old'
      ? (d.embossSource as ToolSource)
      : null
  const prRaw = d.plateRequirement
  const pr =
    prRaw && typeof prRaw === 'object' ? (prRaw as Record<string, unknown>) : {}
  const plateRequirement: PlateRequirement = {
    standardC: typeof pr.standardC === 'boolean' ? pr.standardC : base.plateRequirement.standardC,
    standardM: typeof pr.standardM === 'boolean' ? pr.standardM : base.plateRequirement.standardM,
    standardY: typeof pr.standardY === 'boolean' ? pr.standardY : base.plateRequirement.standardY,
    standardK: typeof pr.standardK === 'boolean' ? pr.standardK : base.plateRequirement.standardK,
    pantoneEnabled: typeof pr.pantoneEnabled === 'boolean' ? pr.pantoneEnabled : false,
    numberOfPantones:
      typeof pr.numberOfPantones === 'number' && Number.isFinite(pr.numberOfPantones)
        ? Math.max(0, Math.floor(pr.numberOfPantones))
        : 0,
    pantone1: typeof pr.pantone1 === 'string' ? pr.pantone1 : '',
    pantone2: typeof pr.pantone2 === 'string' ? pr.pantone2 : '',
    pantone3: typeof pr.pantone3 === 'string' ? pr.pantone3 : '',
    specialColourNote:
      typeof pr.specialColourNote === 'string' ? pr.specialColourNote : '',
    dripOffPlate: typeof pr.dripOffPlate === 'boolean' ? pr.dripOffPlate : false,
    spotUvPlate: typeof pr.spotUvPlate === 'boolean' ? pr.spotUvPlate : false,
  }
  const setType =
    d.setType === 'new_set' ||
    d.setType === 'correction_plate' ||
    d.setType === 'old_set_from_store'
      ? (d.setType as PlateSetType)
      : ''
  return {
    ...base,
    dieSource: die,
    embossSource: emb,
    plateRequirement,
    setType,
    dieLastIntent:
      d.dieLastIntent === 'die_hub' ||
      d.dieLastIntent === 'vendor_po' ||
      d.dieLastIntent === 'store_retrieval'
        ? (d.dieLastIntent as ToolingDispatchIntent)
        : undefined,
    embossLastIntent:
      d.embossLastIntent === 'emboss_hub' ||
      d.embossLastIntent === 'vendor_po' ||
      d.embossLastIntent === 'store_retrieval'
        ? (d.embossLastIntent as ToolingDispatchIntent)
        : undefined,
    dieLastIntentAt: typeof d.dieLastIntentAt === 'string' ? d.dieLastIntentAt : undefined,
    embossLastIntentAt:
      typeof d.embossLastIntentAt === 'string' ? d.embossLastIntentAt : undefined,
    plateHubDispatchAt:
      typeof d.plateHubDispatchAt === 'string' ? d.plateHubDispatchAt : undefined,
  }
}

export const plateRequirementSchema = z.object({
  standardC: z.boolean(),
  standardM: z.boolean(),
  standardY: z.boolean(),
  standardK: z.boolean(),
  pantoneEnabled: z.boolean(),
  numberOfPantones: z.number().int().min(0),
  pantone1: z.string(),
  pantone2: z.string(),
  pantone3: z.string(),
  specialColourNote: z.string(),
  dripOffPlate: z.boolean(),
  spotUvPlate: z.boolean(),
})

const toolingIntentSchema = z
  .enum(['die_hub', 'emboss_hub', 'vendor_po', 'store_retrieval'])
  .nullable()
  .optional()

export const designerCommandSchema = z.object({
  dieSource: z.enum(['new', 'old']).nullable(),
  embossSource: z.enum(['new', 'old']).nullable(),
  plateRequirement: plateRequirementSchema,
  setType: z.enum(['new_set', 'correction_plate', 'old_set_from_store', '']),
  dieLastIntent: toolingIntentSchema,
  embossLastIntent: toolingIntentSchema,
  dieLastIntentAt: z.string().optional(),
  embossLastIntentAt: z.string().optional(),
  plateHubDispatchAt: z.string().optional(),
})

/** Fill only unset tool/set fields from a previous job (AW match). */
export function mergeDesignerCommandFromHistory(
  current: DesignerCommand,
  hist: DesignerCommand | null,
): DesignerCommand {
  if (!hist) return current
  return {
    ...current,
    dieSource: current.dieSource ?? hist.dieSource,
    embossSource: current.embossSource ?? hist.embossSource,
    setType: current.setType || hist.setType,
  }
}
