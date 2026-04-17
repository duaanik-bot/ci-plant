import type { PaletteRecentStored } from '@/lib/command-palette-types'

/** Minimal row shape for resolving command-palette / sidebar targets to a pipeline line. */
export type DirectorLineRef = {
  id: string
  cartonName: string
  po: { id: string; poNumber: string }
  cartonId: string | null
  dieMasterId: string | null
}

export function resolvePaletteEntryToLineId(
  entry: PaletteRecentStored,
  rows: DirectorLineRef[],
): string | null {
  const { href, resultId, groupId } = entry

  if (groupId === 'orders') {
    const m = href.match(/^\/orders\/purchase-orders\/([^/?#]+)/)
    const poId = m?.[1]
    if (poId) {
      const row = rows.find((r) => r.po.id === poId)
      return row?.id ?? null
    }
  }

  if (groupId === 'masters') {
    if (resultId.startsWith('carton-')) {
      const cartonId = resultId.slice('carton-'.length)
      const row = rows.find((r) => r.cartonId === cartonId)
      return row?.id ?? null
    }
    if (resultId.startsWith('artwork-')) {
      const bySubtitle = rows.find(
        (r) =>
          Boolean(entry.subtitle?.includes(r.po.poNumber)) ||
          Boolean(entry.subtitle?.includes(r.cartonName)) ||
          entry.title.includes(r.cartonName),
      )
      if (bySubtitle) return bySubtitle.id
    }
  }

  if (groupId === 'tooling') {
    try {
      const u = new URL(href, 'http://localhost')
      const focus = u.searchParams.get('focusDie')?.trim()
      if (focus) {
        const row = rows.find((r) => r.dieMasterId === focus)
        return row?.id ?? null
      }
    } catch {
      /* ignore */
    }
  }

  return null
}
