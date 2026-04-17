import { z } from 'zod'

/** POST /api/tooling-hub/dispatch — use jobCardId or legacy jobId (PO line id). */
export const toolingHubDispatchBodySchema = z
  .object({
    toolType: z.enum(['DIE', 'BLOCK']),
    artworkId: z.string().optional(),
    awCode: z.string().optional(),
    actualSheetSize: z.string().optional(),
    ups: z.coerce.number().int().min(1).optional(),
    /** Emboss / leaf from PO line (e.g. Embossing, Foil) — maps to BlockType in triage */
    blockType: z.string().optional(),
    cartonSize: z.string().optional(),
    cartonId: z.string().optional(),
    jobCardId: z.string().optional(),
    /** PO line id (designing page sends this as `jobId`) */
    jobId: z.string().optional(),
    setNumber: z.string().min(1, 'setNumber is required'),
    source: z.enum(['NEW', 'OLD']),
  })
  .refine((d) => !!(String(d.jobCardId || '').trim() || String(d.jobId || '').trim()), {
    message: 'jobCardId is required',
    path: ['jobCardId'],
  })
  .refine(
    (d) => {
      const hasArt = !!String(d.artworkId || '').trim()
      if (d.toolType === 'BLOCK') {
        const hasManual =
          !!String(d.awCode || '').trim() && !!String(d.actualSheetSize || '').trim()
        return hasArt || hasManual
      }
      const hasManual =
        !!String(d.awCode || '').trim() &&
        !!String(d.actualSheetSize || '').trim() &&
        d.ups != null &&
        Number.isFinite(d.ups) &&
        d.ups >= 1
      return hasArt || hasManual
    },
    {
      message:
        'Tooling hub: provide artworkId or manual awCode + actualSheetSize (and ups ≥ 1 for dies)',
      path: ['artworkId'],
    },
  )

export type ToolingHubDispatchInput = z.infer<typeof toolingHubDispatchBodySchema>

export type NormalizedToolingHubDispatch = {
  toolType: 'DIE' | 'BLOCK'
  artworkId: string
  awCode: string
  actualSheetSize: string
  ups: number | null
  blockType: string
  cartonSize: string
  cartonId: string
  jobCardId: string
  poLineId: string
  setNumber: string
  source: 'NEW' | 'OLD'
}

export function normalizeDispatchBody(d: ToolingHubDispatchInput): NormalizedToolingHubDispatch {
  const jobCardId = String(d.jobCardId || '').trim()
  const poLineId = String(d.jobId || '').trim()
  return {
    toolType: d.toolType,
    artworkId: String(d.artworkId || '').trim(),
    awCode: String(d.awCode || '').trim(),
    actualSheetSize: String(d.actualSheetSize || '').trim(),
    ups: d.ups != null && Number.isFinite(d.ups) ? d.ups : null,
    blockType: String(d.blockType || '').trim(),
    cartonSize: String(d.cartonSize || '').trim(),
    cartonId: String(d.cartonId || '').trim(),
    jobCardId,
    poLineId,
    setNumber: d.setNumber.trim(),
    source: d.source,
  }
}