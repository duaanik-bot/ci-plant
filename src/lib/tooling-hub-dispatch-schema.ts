import { z } from 'zod'

/** POST /api/tooling-hub/dispatch — use jobCardId or legacy jobId. */
export const toolingHubDispatchBodySchema = z
  .object({
    toolType: z.enum(['DIE', 'BLOCK']),
    artworkId: z.string().min(1, 'artworkId is required'),
    jobCardId: z.string().optional(),
    jobId: z.string().optional(),
    setNumber: z.string().min(1, 'setNumber is required'),
    source: z.enum(['NEW', 'OLD']),
  })
  .refine((d) => !!(String(d.jobCardId || '').trim() || String(d.jobId || '').trim()), {
    message: 'jobCardId is required',
    path: ['jobCardId'],
  })

export type ToolingHubDispatchInput = z.infer<typeof toolingHubDispatchBodySchema>

export function normalizeDispatchBody(d: ToolingHubDispatchInput): {
  toolType: 'DIE' | 'BLOCK'
  artworkId: string
  jobCardId: string
  setNumber: string
  source: 'NEW' | 'OLD'
} {
  const jobCardId = String(d.jobCardId || d.jobId || '').trim()
  return {
    toolType: d.toolType,
    artworkId: d.artworkId.trim(),
    jobCardId,
    setNumber: d.setNumber.trim(),
    source: d.source,
  }
}