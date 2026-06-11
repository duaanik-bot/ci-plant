export type LinkedMaterialRef = { materialId: string | null; materialCode: string | null }

import { normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'

export function materialDescriptionLabel(
  boardType: string | null | undefined,
  gsm: number | null | undefined,
  attributes: string | null | undefined,
): string {
  const board = normalizeBoardTypeForStorage(boardType) || ''
  const gsmPart = gsm && gsm > 0 ? `${gsm} GSM` : ''
  const attrs = (attributes || '').trim()
  return [board, gsmPart, attrs].filter(Boolean).join(' · ')
}

export function materialSizeDisplay(length: unknown, width: unknown, fallback = '-'): string {
  const l = length != null ? Number(length) : null
  const w = width != null ? Number(width) : null
  return l && w ? `${l} x ${w}` : fallback
}

export function linkedMaterialRefs(value: unknown): LinkedMaterialRef[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const rec = entry as Record<string, unknown>
      return {
        materialId: typeof rec.materialId === 'string' ? rec.materialId : null,
        materialCode: typeof rec.materialCode === 'string' ? rec.materialCode : null,
      }
    })
    .filter((entry): entry is LinkedMaterialRef => !!entry)
}

export function linkedMaterialIds(value: unknown): string[] {
  return linkedMaterialRefs(value)
    .map((ref) => ref.materialId)
    .filter((id): id is string => !!id)
}
