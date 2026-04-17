import { z } from 'zod'

export const sizeModificationReasonSchema = z.enum([
  'alternate_machine',
  'edge_damage',
  'prepress_error',
])

export const SIZE_MODIFICATION_REASON_LABELS: Record<
  z.infer<typeof sizeModificationReasonSchema>,
  string
> = {
  alternate_machine: 'Resized for alternate machine assignment',
  edge_damage: 'Trimmed due to edge damage / wear',
  prepress_error: 'Pre-press layout error / Manual correction',
}
