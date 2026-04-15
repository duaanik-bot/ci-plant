import type { DesignerCommand } from '@/lib/designer-command'

/** Human-readable plate line items from pre-press designer command (CMYK, pantones, special). */
export function plateLineItemsFromDesignerCommand(
  cmd: DesignerCommand | null | undefined,
): string[] {
  if (!cmd?.plateRequirement) return []
  const pr = cmd.plateRequirement
  const out: string[] = []
  if (pr.standardC) out.push('C — Process')
  if (pr.standardM) out.push('M — Process')
  if (pr.standardY) out.push('Y — Process')
  if (pr.standardK) out.push('K — Process')
  if (pr.pantoneEnabled && pr.numberOfPantones > 0) {
    const n = Math.min(3, Math.floor(pr.numberOfPantones))
    const labels = [pr.pantone1, pr.pantone2, pr.pantone3]
    for (let i = 0; i < n; i++) {
      const label = (labels[i] || '').trim()
      out.push(label ? `P${i + 1}: ${label}` : `P${i + 1}`)
    }
  }
  if (pr.dripOffPlate) out.push('Drip-off')
  if (pr.spotUvPlate) out.push('Spot UV (plate)')
  if (pr.specialColourNote?.trim()) {
    out.push(`Note: ${pr.specialColourNote.trim()}`)
  }
  return out
}

/** Fallback labels from `plate_requirements.colours_needed` JSON. */
export function plateNamesFromColoursNeededJson(json: unknown): string[] {
  if (!Array.isArray(json)) return []
  const out: string[] = []
  for (const item of json) {
    if (item && typeof item === 'object' && 'name' in item) {
      const name = String((item as { name: string }).name).trim()
      if (name) {
        const isNew =
          'isNew' in item && typeof (item as { isNew?: boolean }).isNew === 'boolean'
            ? (item as { isNew: boolean }).isNew
            : undefined
        out.push(isNew === undefined ? name : `${name}${isNew ? ' (new)' : ' (existing)'}`)
      }
    }
  }
  return out
}

export function resolvePlateLineItems(
  designerCommand: DesignerCommand | null,
  coloursNeededJson: unknown,
): string[] {
  const fromCmd = plateLineItemsFromDesignerCommand(designerCommand ?? undefined)
  if (fromCmd.length > 0) return fromCmd
  return plateNamesFromColoursNeededJson(coloursNeededJson)
}
